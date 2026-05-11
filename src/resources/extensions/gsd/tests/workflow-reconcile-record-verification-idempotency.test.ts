// GSD Extension — workflow-reconcile record_verification idempotency test
// (M003/S01 Bug 3, D004 reproduce-and-prevent / D011 hardening).
//
// The bug: pre-fix the `record_verification` arm of `replayEvents` called
// `insertVerificationEvidence` with no idempotency key. Replaying the same
// event twice (crash recovery, manual `gsd reconcile` re-run, worktree
// merge-back) inserted two rows in `verification_evidence`.
//
// The fix: a new V29 migration adds a UNIQUE `event_hash TEXT DEFAULT NULL`
// column to `verification_evidence`. The replay arm forwards the
// WorkflowEvent's content hash (16-hex sha256 of {cmd, params}) as
// `eventHash`, which the writer binds to the new column. SQLite's UNIQUE
// constraint makes the second insert a silent INSERT OR IGNORE no-op.
//
// D011 reproduction note (recorded honestly): the M5 event-replay-idempotency
// finding asserted "duplicates accumulate." That assertion holds ONLY when
// the existing `idx_verification_evidence_dedup` UNIQUE index on
// (task_id, slice_id, milestone_id, command, verdict) is absent or when
// the duplicate inserts vary on a non-tuple field. Empirical probe
// (gsd_exec 6d907a6b-da7b-425e-82a9-4f02ee70cfd5) confirmed: with the
// dedup index ON, identical-tuple double-insert already yields row count = 1.
//
// To produce a meaningful D004 reproduce-and-prevent we vary `duration_ms`
// (NOT in the legacy dedup tuple) between the two replays. Pre-fix that
// would produce 2 rows; post-fix the new event_hash UNIQUE alone gates
// to 1 row, even though the legacy dedup tuple differs because of the
// `INSERT OR IGNORE` semantics on the UNIQUE event_hash column.
//
// The end-to-end test drives the actual `replayEvents` switch case via
// `reconcileWorktreeLogs` so the seam wiring is exercised under
// production conditions.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

import { appendEvent, readEvents, type WorkflowEvent } from '../workflow-events.ts';
import {
  reconcileWorktreeLogs,
  _setRecordVerificationIdempotencyForTests,
  _resetRecordVerificationIdempotencyForTests,
} from '../workflow-reconcile.ts';
import {
  openDatabase,
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertTask,
  insertVerificationEvidence,
  transaction,
} from '../gsd-db.ts';

const MID = 'M001';
const SID = 'S01';
const TID = 'T01';

function tempBase(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-record-verif-idemp-'));
}

function cleanup(p: string): void {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* best effort */ }
}

function seedHierarchy(): void {
  insertMilestone({ id: MID, title: 'M001' });
  insertSlice({ id: SID, milestoneId: MID, title: 'S01' });
  insertTask({ id: TID, sliceId: SID, milestoneId: MID, title: 'T01' });
}

/** Produce a record_verification event by routing it through `appendEvent`,
 * then reading it back so we get the engine-computed `hash`. */
function buildRecordVerificationEvent(base: string): WorkflowEvent {
  const logPath = path.join(base, '.gsd', 'event-log.jsonl');
  if (fs.existsSync(logPath)) fs.unlinkSync(logPath);
  appendEvent(base, {
    cmd: 'record_verification',
    params: {
      milestoneId: MID,
      sliceId: SID,
      taskId: TID,
      command: 'npm test',
      exitCode: 0,
      verdict: 'pass',
      durationMs: 1200,
    },
    ts: '2026-01-01T00:00:00.000Z',
    actor: 'agent',
  });
  const events = readEvents(logPath);
  assert.equal(events.length, 1, 'seed event must be readable');
  return events[0]!;
}

test('insertVerificationEvidence: same eventHash twice → 1 row (post-fix V29 event_hash UNIQUE)', (t) => {
  const base = tempBase();
  const dbPath = path.join(base, 'gsd.db');

  openDatabase(dbPath);
  seedHierarchy();

  t.after(() => {
    _resetRecordVerificationIdempotencyForTests();
    closeDatabase();
    cleanup(base);
  });

  const event = buildRecordVerificationEvent(base);

  // Two inserts with the SAME eventHash but DIFFERENT durationMs (which
  // is NOT in the legacy dedup tuple). Pre-fix this produces 2 rows;
  // post-fix the new event_hash UNIQUE makes the second insert a silent
  // INSERT OR IGNORE no-op.
  transaction(() => {
    insertVerificationEvidence({
      taskId: TID, sliceId: SID, milestoneId: MID,
      command: 'npm test', exitCode: 0, verdict: 'pass',
      durationMs: 1200,
      eventHash: event.hash,
    });
  });
  transaction(() => {
    insertVerificationEvidence({
      taskId: TID, sliceId: SID, milestoneId: MID,
      command: 'npm test', exitCode: 0, verdict: 'pass',
      durationMs: 9999, // varies non-dedup field; would produce 2 rows pre-fix
      eventHash: event.hash, // same hash → INSERT OR IGNORE no-ops
    });
  });

  closeDatabase();

  const probe = new DatabaseSync(dbPath);
  try {
    // Confirm V29 column exists.
    const cols = probe.prepare('PRAGMA table_info(verification_evidence)').all() as Array<{ name: string }>;
    const hasHashCol = cols.some((c) => c.name === 'event_hash');
    assert.ok(hasHashCol, 'V29 migration must add event_hash column to verification_evidence');

    // Confirm SQLite auto-created a UNIQUE index for the column.
    const indexes = probe.prepare('PRAGMA index_list(verification_evidence)').all() as Array<{ name: string; unique: number }>;
    const hasUniqueIndex = indexes.some((i) => i.unique === 1);
    assert.ok(hasUniqueIndex, 'verification_evidence must have a UNIQUE index covering event_hash');

    const cnt = (probe.prepare(
      'SELECT COUNT(*) AS c FROM verification_evidence WHERE event_hash = ?',
    ).get(event.hash) as { c: number }).c;
    assert.equal(cnt, 1, `post-fix: duplicate replay must dedupe to 1 row by event_hash UNIQUE; got ${cnt}`);

    // INSERT OR IGNORE must keep the FIRST row (durationMs=1200), not the
    // second (9999). This proves the gate fired before the second write.
    const dur = (probe.prepare(
      'SELECT duration_ms AS d FROM verification_evidence WHERE event_hash = ?',
    ).get(event.hash) as { d: number }).d;
    assert.equal(dur, 1200, 'INSERT OR IGNORE must keep the first-write row (duration_ms=1200), not the second (9999)');

    // Multiple NULL event_hash rows must remain allowed (non-replay
    // callers like complete-task pass undefined → bound NULL).
    const nullsBefore = (probe.prepare(
      'SELECT COUNT(*) AS c FROM verification_evidence WHERE event_hash IS NULL',
    ).get() as { c: number }).c;
    assert.equal(nullsBefore, 0, 'baseline: no NULL event_hash rows from this test');
  } finally {
    probe.close();
  }
});

test('insertVerificationEvidence: multiple NULL event_hash rows remain allowed (direct callers unaffected)', (t) => {
  const base = tempBase();
  const dbPath = path.join(base, 'gsd.db');

  openDatabase(dbPath);
  seedHierarchy();

  t.after(() => {
    closeDatabase();
    cleanup(base);
  });

  // Direct callers (e.g. complete-task) do NOT pass eventHash. SQLite
  // UNIQUE-with-NULLs allows arbitrarily many NULLs. We must allow at
  // least one direct insert without throwing — and a SECOND insert with
  // a different command/verdict must also land (different legacy dedup
  // tuple). The legacy dedup index (task_id, slice_id, milestone_id,
  // command, verdict) prevents IDENTICAL direct inserts, but that's the
  // pre-existing behavior — V29 does not regress it.
  transaction(() => {
    insertVerificationEvidence({
      taskId: TID, sliceId: SID, milestoneId: MID,
      command: 'npm run lint', exitCode: 0, verdict: 'pass', durationMs: 100,
    });
  });
  transaction(() => {
    insertVerificationEvidence({
      taskId: TID, sliceId: SID, milestoneId: MID,
      command: 'npm run typecheck', exitCode: 0, verdict: 'pass', durationMs: 200,
    });
  });

  closeDatabase();
  const probe = new DatabaseSync(dbPath);
  try {
    const cnt = (probe.prepare(
      'SELECT COUNT(*) AS c FROM verification_evidence WHERE event_hash IS NULL',
    ).get() as { c: number }).c;
    assert.equal(cnt, 2, 'two direct callers (no eventHash) must produce 2 NULL-hash rows');
  } finally {
    probe.close();
  }
});

test('reconcile end-to-end: two identical record_verification events from worktree dedupe to 1 row via event_hash UNIQUE (M003/S01 Bug 3)', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-record-verif-e2e-'));
  const main = path.join(root, 'main');
  const worktree = path.join(root, 'worktree');
  fs.mkdirSync(main, { recursive: true });
  fs.mkdirSync(worktree, { recursive: true });

  const dbPath = path.join(main, '.gsd', 'gsd.db');
  fs.mkdirSync(path.join(main, '.gsd'), { recursive: true });
  openDatabase(dbPath);
  seedHierarchy();
  closeDatabase();

  t.after(() => {
    closeDatabase();
    cleanup(root);
  });

  // Common base on both sides so the fork point includes the seed.
  appendEvent(main, {
    cmd: 'plan_milestone', params: { milestoneId: MID, title: 'M001' },
    ts: '2026-01-01T00:00:00.000Z', actor: 'agent',
  });
  appendEvent(worktree, {
    cmd: 'plan_milestone', params: { milestoneId: MID, title: 'M001' },
    ts: '2026-01-01T00:00:00.000Z', actor: 'agent',
  });

  // Two identical-content record_verification events on the worktree
  // side. event.hash is computed only from {cmd, params}, so both events
  // share the same hash even though `ts` differs.
  appendEvent(worktree, {
    cmd: 'record_verification',
    params: {
      milestoneId: MID, sliceId: SID, taskId: TID,
      command: 'npm test', exitCode: 0, verdict: 'pass', durationMs: 1200,
    },
    ts: '2026-01-01T00:01:00.000Z', actor: 'agent',
  });
  appendEvent(worktree, {
    cmd: 'record_verification',
    params: {
      milestoneId: MID, sliceId: SID, taskId: TID,
      command: 'npm test', exitCode: 0, verdict: 'pass', durationMs: 1200,
    },
    ts: '2026-01-01T00:02:00.000Z', actor: 'agent',
  });

  // The reconciler re-opens the DB at the latest schema (V29) and runs
  // both events through the production replayEvents switch case.
  const result = reconcileWorktreeLogs(main, worktree);
  assert.equal(result.conflicts.length, 0, `expected clean merge, got ${result.conflicts.length} conflicts`);

  closeDatabase();
  const probe = new DatabaseSync(dbPath);
  try {
    const cnt = (probe.prepare(
      'SELECT COUNT(*) AS c FROM verification_evidence WHERE task_id = ? AND event_hash IS NOT NULL',
    ).get(TID) as { c: number }).c;
    assert.equal(
      cnt, 1,
      `post-fix: two identical record_verification replays via reconcile must dedupe to 1 row via event_hash UNIQUE; got ${cnt}`,
    );

    // event_hash must be the engine-computed 16-hex sha256.
    const hashRow = probe.prepare(
      'SELECT event_hash AS h FROM verification_evidence WHERE task_id = ?',
    ).get(TID) as { h: string };
    assert.match(hashRow.h, /^[0-9a-f]{16}$/, `event_hash must be 16-hex; got "${hashRow.h}"`);
  } finally {
    probe.close();
  }
});

test('record_verification idempotency seam: _setRecordVerificationIdempotencyForTests intercepts the writer, _reset restores default', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-record-verif-seam-'));
  const main = path.join(root, 'main');
  const worktree = path.join(root, 'worktree');
  fs.mkdirSync(main, { recursive: true });
  fs.mkdirSync(worktree, { recursive: true });

  const dbPath = path.join(main, '.gsd', 'gsd.db');
  fs.mkdirSync(path.join(main, '.gsd'), { recursive: true });
  openDatabase(dbPath);
  seedHierarchy();
  closeDatabase();

  let intercepted = 0;
  let lastHash: string | null = null;
  let lastArgsHash: string | undefined | null = null;

  t.after(() => {
    _resetRecordVerificationIdempotencyForTests();
    closeDatabase();
    cleanup(root);
  });

  _setRecordVerificationIdempotencyForTests((args, eventHash) => {
    intercepted += 1;
    lastHash = eventHash;
    lastArgsHash = args.eventHash;
  });

  // Seed common base + a single record_verification event.
  appendEvent(main, {
    cmd: 'plan_milestone', params: { milestoneId: MID, title: 'M001' },
    ts: '2026-01-01T00:00:00.000Z', actor: 'agent',
  });
  appendEvent(worktree, {
    cmd: 'plan_milestone', params: { milestoneId: MID, title: 'M001' },
    ts: '2026-01-01T00:00:00.000Z', actor: 'agent',
  });
  appendEvent(worktree, {
    cmd: 'record_verification',
    params: {
      milestoneId: MID, sliceId: SID, taskId: TID,
      command: 'npm test', exitCode: 0, verdict: 'pass', durationMs: 1200,
    },
    ts: '2026-01-01T00:01:00.000Z', actor: 'agent',
  });

  const result = reconcileWorktreeLogs(main, worktree);
  assert.equal(result.conflicts.length, 0, 'expected clean merge');

  assert.equal(intercepted, 1, 'seam must fire exactly once for the single record_verification event');
  assert.equal(typeof lastHash, 'string', 'forwarded eventHash must be a string');
  assert.match(lastHash as unknown as string, /^[0-9a-f]{16}$/, 'forwarded eventHash must be 16-hex');
  assert.equal(lastArgsHash, lastHash, 'args.eventHash must match the second positional eventHash arg');

  // No real insert happened (seam intercepted) — verify by probing the DB.
  closeDatabase();
  const probe = new DatabaseSync(dbPath);
  try {
    const cnt = (probe.prepare(
      'SELECT COUNT(*) AS c FROM verification_evidence WHERE task_id = ?',
    ).get(TID) as { c: number }).c;
    assert.equal(cnt, 0, 'when the seam intercepts, no real insert lands');
  } finally {
    probe.close();
  }
});
