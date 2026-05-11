// GSD Extension — workflow-events appendEvent race test (M003/S01 Bug 1, D004 reproduce-and-prevent).
//
// The bug: pre-fix `appendEvent` writes to `event-log.jsonl` without acquiring
// the same `withFileLockSync` primitive that `compactMilestoneEvents` already
// uses. A concurrent compact's `atomicWriteSync` rename can swap the inode out
// from under an in-flight `appendFileSync`, causing the appended event to land
// on a dead (now-unlinked) inode that gets reclaimed when the fd closes — a
// silent-drop.
//
// Strategy (per S01-RESEARCH "Cleaner alternative" + S01-PLAN seam D008):
// inject `appendFileSync` via `_setAppendEventFsForTests`. The injected
// version (a) opens a manual `'a'`-mode fd to the log, (b) synchronously
// fires `compactMilestoneEvents(base, 'M001')` which atomic-renames the log
// inode, (c) writes the line to the fd. Pre-fix the planted compact succeeds
// → the rename swaps the inode → the subsequent write goes to a dead inode →
// event LOST. Post-fix the planted compact ELOCKEDs (because the outer
// `appendEvent` now holds the lock and proper-lockfile rejects same-process
// re-entry) → no rename happens → the fd is still valid → event PRESERVED.
//
// Defense-in-depth assertion: we also assert the xor invariant
// `ranSuccessfully !== blocked` so a future regression where the seam is
// silently skipped surfaces explicitly rather than passing trivially.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  appendEvent,
  readEvents,
  compactMilestoneEvents,
  _setAppendEventFsForTests,
  _resetAppendEventFsForTests,
  type WorkflowEvent,
} from '../workflow-events.ts';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-events-race-'));
}

function cleanupDir(dirPath: string): void {
  try { fs.rmSync(dirPath, { recursive: true, force: true }); } catch { /* best effort */ }
}

function makeEvent(cmd: string, params: Record<string, unknown> = {}): Omit<WorkflowEvent, 'hash' | 'session_id'> {
  return { cmd, params, ts: new Date().toISOString(), actor: 'agent' };
}

test('workflow-events: appendEvent serializes against compactMilestoneEvents truncate (M003/S01 Bug 1)', (t) => {
  const base = tempDir();
  t.after(() => {
    _resetAppendEventFsForTests();
    cleanupDir(base);
  });

  // Seed one M001 event so compact has something to archive (the truncate
  // path is what unlinks the active-log inode and triggers the silent drop).
  appendEvent(base, makeEvent('plan-task', { milestoneId: 'M001', taskId: 'T00-SEED' }));

  const logPath = path.join(base, '.gsd', 'event-log.jsonl');

  // Sanity: confirm seed landed and the file exists so withFileLockSync
  // doesn't short-circuit on the next call (file-lock.ts:79).
  assert.strictEqual(readEvents(logPath).length, 1, 'seed must be present before race');

  let injectedAppendCalls = 0;
  let plantedCompactRanSuccessfully = false;
  let plantedCompactBlocked = false;

  _setAppendEventFsForTests({
    appendFileSync: ((target: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, _encoding?: any) => {
      injectedAppendCalls += 1;
      const targetPath = target as string;

      // (a) Open an append-mode fd manually. After this open, the fd is bound
      //     to the current inode. If a concurrent compact renames the path,
      //     this fd becomes a dangling reference to an unlinked inode.
      const fd = fs.openSync(targetPath, 'a');
      try {
        // (b) Fire the planted compact INSIDE our injected append. Pre-fix
        //     this acquires the lock (appendEvent holds nothing), truncates
        //     the active log, and unlinks our fd's inode. Post-fix this
        //     ELOCKEDs because appendEvent's outer withFileLockSync owns the
        //     lock (proper-lockfile rejects same-process re-entry).
        try {
          compactMilestoneEvents(base, 'M001');
          plantedCompactRanSuccessfully = true;
        } catch (err: any) {
          if (err?.code === 'ELOCKED') {
            plantedCompactBlocked = true;
          } else {
            throw err;
          }
        }

        // (c) Write the line to the fd. Pre-fix this writes to a dead inode
        //     (lost on close). Post-fix the fd is still valid → event lands.
        const buf = typeof data === 'string' ? Buffer.from(data, 'utf-8') : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
        fs.writeSync(fd, buf);
      } finally {
        fs.closeSync(fd);
      }
    }) as typeof fs.appendFileSync,
  });

  // The racy append. Use M001 so a successful planted compact would archive
  // the seed (clearing the active log) — making the silent-drop visible by
  // checking both active log and archive.
  appendEvent(base, makeEvent('complete-task', { milestoneId: 'M001', taskId: 'T01-RACY' }));

  _resetAppendEventFsForTests();

  // Inspect both active log and archive for the racy event.
  const activeEvents = readEvents(logPath);
  const archivePath = path.join(base, '.gsd', 'event-log-M001.jsonl.archived');
  const archivedEvents = fs.existsSync(archivePath) ? readEvents(archivePath) : [];

  const racyInActive = activeEvents.some((e) => (e.params as { taskId?: string }).taskId === 'T01-RACY');
  const racyInArchive = archivedEvents.some((e) => (e.params as { taskId?: string }).taskId === 'T01-RACY');
  const racyPreserved = racyInActive || racyInArchive;

  // The seam must have fired exactly once — guards against a regression
  // where the override is skipped and the test passes trivially.
  assert.strictEqual(injectedAppendCalls, 1,
    `expected the injected appendFileSync to fire exactly once for the racy event; ` +
    `got ${injectedAppendCalls} calls`);

  // Exactly one of {ran-successfully, blocked} must be true. Post-fix:
  // blocked. Pre-fix: ran-successfully. Both true or both false would be a
  // structural break in the test plumbing.
  assert.notStrictEqual(plantedCompactRanSuccessfully, plantedCompactBlocked,
    `expected exactly one of {ranSuccessfully, blocked}; ` +
    `got ran=${plantedCompactRanSuccessfully} blocked=${plantedCompactBlocked}`);

  // Post-fix invariant 1: the planted compact must have hit ELOCKED because
  // appendEvent holds the lock. Pre-fix this assertion fails — compact was
  // free to truncate.
  assert.ok(plantedCompactBlocked,
    `post-fix: the planted compactMilestoneEvents must ELOCKED because appendEvent ` +
    `holds withFileLockSync; instead it ran successfully — appendEvent is NOT ` +
    `serialized against compact (active=${activeEvents.length}, archive=${archivedEvents.length}, ` +
    `racyInActive=${racyInActive}, racyInArchive=${racyInArchive})`);

  // Post-fix invariant 2: the racy event must survive (in active log or
  // archive). Pre-fix this fails — the event was written to a dead inode.
  assert.ok(racyPreserved,
    `post-fix: racy event T01-RACY must be preserved in either active log or archive; ` +
    `it was DROPPED (active=${activeEvents.length}, archive=${archivedEvents.length})`);
});

test('workflow-events: _setAppendEventFsForTests / _resetAppendEventFsForTests reset to default behavior', (t) => {
  const base = tempDir();
  t.after(() => {
    _resetAppendEventFsForTests();
    cleanupDir(base);
  });

  let intercepted = 0;
  _setAppendEventFsForTests({
    appendFileSync: ((p: any, d: any, e: any) => {
      intercepted += 1;
      // Delegate to real appendFileSync so the test still produces output.
      fs.appendFileSync(p, d, e);
    }) as typeof fs.appendFileSync,
  });

  appendEvent(base, makeEvent('intercepted', { taskId: 'T1' }));
  assert.strictEqual(intercepted, 1, 'override must intercept');

  _resetAppendEventFsForTests();

  appendEvent(base, makeEvent('not-intercepted', { taskId: 'T2' }));
  assert.strictEqual(intercepted, 1, 'reset must restore default appendFileSync (count must NOT advance)');

  const logPath = path.join(base, '.gsd', 'event-log.jsonl');
  const events = readEvents(logPath);
  assert.strictEqual(events.length, 2, 'both events must be on disk regardless of seam state');
});
