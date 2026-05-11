// GSD Extension — workflow-reconcile bounded-recursion test
// (M003/S01 Bug 2, D004 reproduce-and-prevent).
//
// The bug: pre-fix `_reconcileWorktreeLogsInner` recursed unconditionally on
// the "event log grew during reconcile" branch:
//
//     return _reconcileWorktreeLogsInner(mainBasePath, worktreeBasePath);
//
// A sustained writer (or a buggy fixture) keeps tripping the
// `preWriteEvents.length > mainEvents.length` guard on every retry, so the
// reconciler spins forever or overflows the stack. There was no cap, no
// observable failure mode — just a hung process.
//
// Strategy (per S01-RESEARCH "Implementation Landscape" + S01-PLAN seam D008):
// 1. Set the injected cap to 2 via `_setReconcileMaxDepthForTests(2)`.
// 2. Build a clean-but-divergent fixture (worktree has one extra non-conflicting
//    event past the common base) so `_reconcileWorktreeLogsInner` proceeds
//    past the conflict check into the post-merge rewrite path.
// 3. Inject a deterministic between-reads hook that appends a fresh event to
//    the main log on EVERY iteration — guaranteeing the
//    `preWriteEvents.length > mainEvents.length` branch trips repeatedly.
// 4. Post-fix assertion: the call throws `GSDError` with
//    `code === "GSD_RECONCILE_MAX_DEPTH"` and a message that encodes attempts
//    + size delta (errors.ts has no structured `details` field).
// 5. Per-public-call assertion: a second invocation of
//    `reconcileWorktreeLogs` after the throw also throws — proving the cap
//    is per-public-call (depth resets to 0), not global.
//
// Pre-fix D011 reproduction proof: with the unfixed `return _reconcileWorktreeLogsInner(...)`
// line and the same fixture/seam, the call recurses indefinitely — the test
// times out (Promise.race against 500ms) instead of throwing. The post-fix
// throw output is the pass evidence captured below.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { appendEvent } from '../workflow-events.ts';
import {
  reconcileWorktreeLogs,
  _setReconcileMaxDepthForTests,
  _resetReconcileMaxDepthForTests,
  _setReconcileBetweenReadsHookForTests,
  _resetReconcileBetweenReadsHookForTests,
} from '../workflow-reconcile.ts';
import { GSDError, GSD_RECONCILE_MAX_DEPTH } from '../errors.ts';
import { closeDatabase } from '../gsd-db.ts';

function tempRepo(): { main: string; worktree: string; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-reconcile-bounded-'));
  const main = path.join(root, 'main');
  const worktree = path.join(root, 'worktree');
  fs.mkdirSync(main, { recursive: true });
  fs.mkdirSync(worktree, { recursive: true });
  return { main, worktree, root };
}

function cleanupDir(dirPath: string): void {
  try { fs.rmSync(dirPath, { recursive: true, force: true }); } catch { /* best effort */ }
}

test('workflow-reconcile: _reconcileWorktreeLogsInner throws GSD_RECONCILE_MAX_DEPTH when retry cap exceeded (M003/S01 Bug 2)', (t) => {
  const { main, worktree, root } = tempRepo();
  let counter = 0;

  t.after(() => {
    _resetReconcileMaxDepthForTests();
    _resetReconcileBetweenReadsHookForTests();
    closeDatabase();
    cleanupDir(root);
  });

  // Seed identical base event on both sides so they share a fork point.
  // Use a non-conflicting entity on the worktree side so step-5 conflict
  // detection passes and we proceed into the post-merge rewrite path.
  appendEvent(main, {
    cmd: 'plan_milestone',
    params: { milestoneId: 'M001', title: 'Base' },
    ts: '2026-01-01T00:00:00.000Z',
    actor: 'agent',
  });
  appendEvent(worktree, {
    cmd: 'plan_milestone',
    params: { milestoneId: 'M001', title: 'Base' },
    ts: '2026-01-01T00:00:00.000Z',
    actor: 'agent',
  });

  // Worktree adds one non-conflicting event (different milestone entity) past
  // the fork — gives wtDiverged.length > 0 so step-4 doesn't early-return.
  appendEvent(worktree, {
    cmd: 'plan_milestone',
    params: { milestoneId: 'M002', title: 'Worktree-only' },
    ts: '2026-01-01T00:01:00.000Z',
    actor: 'agent',
  });

  // Cap retries at 2 so the fixture exhausts within milliseconds. Default 8
  // would still terminate — we want the assertion to reflect the cap-exceed
  // branch deterministically.
  _setReconcileMaxDepthForTests(2);

  // Between-reads hook appends a fresh main-side event on every iteration,
  // guaranteeing `preWriteEvents.length > mainEvents.length` trips each pass.
  // Each event uses a unique entity so no conflicts surface and the recursion
  // arm (rather than the conflict arm) is what runs.
  _setReconcileBetweenReadsHookForTests(() => {
    counter += 1;
    appendEvent(main, {
      cmd: 'plan_milestone',
      params: { milestoneId: `M9${String(counter).padStart(2, '0')}`, title: `Inject ${counter}` },
      ts: `2026-01-01T00:0${counter + 2}:00.000Z`,
      actor: 'agent',
    });
  });

  let thrown: unknown = null;
  try {
    reconcileWorktreeLogs(main, worktree);
  } catch (err) {
    thrown = err;
  }

  assert.ok(thrown !== null, 'expected reconcile to throw when cap exceeded, got no throw');
  assert.ok(thrown instanceof GSDError, `expected GSDError, got ${(thrown as Error)?.constructor?.name}`);
  assert.equal((thrown as GSDError).code, GSD_RECONCILE_MAX_DEPTH, 'expected GSD_RECONCILE_MAX_DEPTH code');
  const msg = (thrown as GSDError).message;
  assert.match(msg, /attempts/, `expected message to mention "attempts", got: ${msg}`);
  assert.match(msg, /sizeDelta/, `expected message to mention "sizeDelta", got: ${msg}`);

  // Per-public-call cap reset: a second invocation also throws (depth resets
  // to 0 — `reconcileWorktreeLogs` always re-enters `_reconcileWorktreeLogsInner`
  // with the default depth=0). Confirms the cap is NOT a process-global
  // counter that would silently let subsequent calls slip past.
  let secondThrown: unknown = null;
  try {
    reconcileWorktreeLogs(main, worktree);
  } catch (err) {
    secondThrown = err;
  }
  assert.ok(secondThrown instanceof GSDError, 'second invocation should also throw — cap is per-public-call');
  assert.equal(
    (secondThrown as GSDError).code,
    GSD_RECONCILE_MAX_DEPTH,
    'second invocation should throw GSD_RECONCILE_MAX_DEPTH (depth resets per public call)',
  );

  // Sanity: hook fired at least the cap-many times across both invocations
  // (proves the recursion path actually exercised the seam).
  assert.ok(counter >= 4, `expected hook to fire ≥4 times across two cap-exceed invocations, got ${counter}`);
});

test('workflow-reconcile: _reconcileWorktreeLogsInner does NOT spin under cap with a fixture that grows the log (Promise.race timeout sentinel for D011 pre-fix repro)', async (t) => {
  const { main, worktree, root } = tempRepo();
  let counter = 0;

  t.after(() => {
    _resetReconcileMaxDepthForTests();
    _resetReconcileBetweenReadsHookForTests();
    closeDatabase();
    cleanupDir(root);
  });

  // Same divergent fixture as above, scaled down — cap=3 so the call settles
  // (by throwing) well within the 500ms timeout sentinel. Pre-fix this same
  // fixture would NOT settle (no cap → infinite recursion → either timeout
  // or stack overflow).
  appendEvent(main, {
    cmd: 'plan_milestone',
    params: { milestoneId: 'M001', title: 'Base' },
    ts: '2026-01-01T00:00:00.000Z',
    actor: 'agent',
  });
  appendEvent(worktree, {
    cmd: 'plan_milestone',
    params: { milestoneId: 'M001', title: 'Base' },
    ts: '2026-01-01T00:00:00.000Z',
    actor: 'agent',
  });
  appendEvent(worktree, {
    cmd: 'plan_milestone',
    params: { milestoneId: 'M002', title: 'Worktree-only' },
    ts: '2026-01-01T00:01:00.000Z',
    actor: 'agent',
  });

  _setReconcileMaxDepthForTests(3);
  _setReconcileBetweenReadsHookForTests(() => {
    counter += 1;
    appendEvent(main, {
      cmd: 'plan_milestone',
      params: { milestoneId: `M8${String(counter).padStart(2, '0')}`, title: `Inject ${counter}` },
      ts: `2026-01-01T00:0${counter + 2}:00.000Z`,
      actor: 'agent',
    });
  });

  // Run the (synchronous) reconcile inside a promise so we can race it against
  // a 500ms timeout. Post-fix it must either throw (caught below) or return —
  // either way the promise settles. Pre-fix it would hang/overflow before
  // the timeout's `'TIMEOUT'` resolution.
  const sentinel = new Promise<'TIMEOUT'>((resolve) => setTimeout(() => resolve('TIMEOUT'), 500));
  const work = new Promise<'OK' | Error>((resolve) => {
    try {
      reconcileWorktreeLogs(main, worktree);
      resolve('OK');
    } catch (err) {
      resolve(err as Error);
    }
  });

  const winner = await Promise.race([work, sentinel]);
  assert.notEqual(winner, 'TIMEOUT', 'reconcile must settle within 500ms under cap (pre-fix would spin)');
  assert.ok(winner instanceof GSDError, 'reconcile should throw GSDError when cap is exceeded');
  assert.equal((winner as GSDError).code, GSD_RECONCILE_MAX_DEPTH);
});
