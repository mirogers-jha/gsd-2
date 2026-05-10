// gsd-2 + crash-recovery dispatch-ledger cleanup (M002/S04 follow-up — Bug B1)
//
// D004 reproduce-and-prevent gate.
//
// Pre-fix behavior: `emitCrashRecoveredUnitEnd` synthesizes a journal
// `unit-end` event for a crashed unit but DOES NOT release the
// `unit_dispatches` row that the crashed worker claimed. Because the
// partial unique index `idx_unit_dispatches_active_per_unit` keys on
// `unit_id` ALONE (not `unit_type`+`unit_id`), the surviving `running`
// row blocks ALL future dispatches sharing that `unit_id` — including
// dispatches of a different `unit_type`.
//
// Real-world reproduction (M002/S04 stuck-loop forensics, journal flow
// d7fe0497 → c4ab3fc7 → 375f4cdf → 76e39c10 → d391428b → auto-exit):
// a crashed `plan-slice/M002/S04` left an `unit_dispatches.status='running'`
// row; subsequent `research-slice/M002/S04` dispatches all silently failed
// at the dispatch-claim step (recordDispatchClaim → already_active),
// burning iterations until the stuck-detector tripped with
// "derived 3 consecutive times without progress" — the wrong root cause.
//
// Post-fix behavior: `emitCrashRecoveredUnitEnd` ALSO calls
// `markActiveForUnitFailed(lock.unitId, "crash-recovered")`, releasing
// the row so later dispatches can claim it.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  openDatabase,
  closeDatabase,
  insertMilestone,
  insertSlice,
} from "../gsd-db.ts";
import { registerAutoWorker } from "../db/auto-workers.ts";
import { claimMilestoneLease } from "../db/milestone-leases.ts";
import {
  recordDispatchClaim,
  markRunning,
  markCompleted,
  getLatestForUnit,
  markActiveForUnitFailed,
} from "../db/unit-dispatches.ts";
import { emitCrashRecoveredUnitEnd, type LockData } from "../crash-recovery.ts";

function makeBase(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-crash-ledger-"));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  return base;
}

function cleanup(base: string): void {
  try { closeDatabase(); } catch { /* noop */ }
  try { rmSync(base, { recursive: true, force: true }); } catch { /* noop */ }
}

function seed(base: string): { workerId: string; leaseToken: number } {
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M002", title: "Test M002", status: "active" });
  insertSlice({ id: "S04", milestoneId: "M002", title: "Test S04" });
  const workerId = registerAutoWorker({ projectRootRealpath: base });
  const lease = claimMilestoneLease(workerId, "M002");
  assert.equal(lease.ok, true);
  if (!lease.ok) throw new Error("expected test lease");
  return { workerId, leaseToken: lease.token };
}

function makeLock(unitType: string, unitId: string): LockData {
  return {
    pid: 12345,
    startedAt: new Date().toISOString(),
    unitType,
    unitId,
    unitStartedAt: new Date().toISOString(),
  };
}

test("markActiveForUnitFailed releases all active rows for the unit_id", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  const { workerId, leaseToken } = seed(base);

  const claim = recordDispatchClaim({
    traceId: "trace-crashed",
    workerId,
    milestoneLeaseToken: leaseToken,
    milestoneId: "M002",
    sliceId: "S04",
    unitType: "plan-slice",
    unitId: "M002/S04",
  });
  assert.equal(claim.ok, true);
  if (!claim.ok) return;
  markRunning(claim.dispatchId);

  const before = getLatestForUnit("M002/S04");
  assert.equal(before?.status, "running");

  const updated = markActiveForUnitFailed("M002/S04", "crash-recovered");
  assert.equal(updated, 1);

  const after = getLatestForUnit("M002/S04");
  assert.equal(after?.status, "failed");
  assert.equal(after?.error_summary, "crash-recovered");
  assert.equal(after?.exit_reason, "crash-recovered");
  assert.ok(after?.ended_at, "ended_at must be populated when row is failed");
});

test("markActiveForUnitFailed is a no-op when no active rows exist", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  seed(base);

  const updated = markActiveForUnitFailed("M002/S99", "crash-recovered");
  assert.equal(updated, 0);
});

test("markActiveForUnitFailed leaves completed rows alone (only updates claimed/running)", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  const { workerId, leaseToken } = seed(base);

  const c1 = recordDispatchClaim({
    traceId: "trace-1",
    workerId,
    milestoneLeaseToken: leaseToken,
    milestoneId: "M002",
    sliceId: "S04",
    unitType: "plan-slice",
    unitId: "M002/S04",
  });
  assert.equal(c1.ok, true);
  if (!c1.ok) return;
  markRunning(c1.dispatchId);

  // Mark this one completed — emulate the happy path where a previous
  // dispatch finished successfully and shouldn't be disturbed by crash
  // recovery.
  markCompleted(c1.dispatchId);

  // No active rows should remain → markActiveForUnitFailed is no-op.
  const updated = markActiveForUnitFailed("M002/S04", "crash-recovered");
  assert.equal(updated, 0);

  const row = getLatestForUnit("M002/S04");
  assert.equal(row?.status, "completed");
});

test("D004 — emitCrashRecoveredUnitEnd RELEASES the dispatch ledger so later dispatches can claim", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  const { workerId, leaseToken } = seed(base);

  // Step 1: simulate the crashed plan-slice — claim the unit, mark
  // running, then leave it that way (the worker died mid-flight).
  const crashedClaim = recordDispatchClaim({
    traceId: "trace-crashed-plan-slice",
    workerId,
    milestoneLeaseToken: leaseToken,
    milestoneId: "M002",
    sliceId: "S04",
    unitType: "plan-slice",
    unitId: "M002/S04",
  });
  assert.equal(crashedClaim.ok, true);
  if (!crashedClaim.ok) return;
  markRunning(crashedClaim.dispatchId);
  assert.equal(getLatestForUnit("M002/S04")?.status, "running");

  // Step 2: a fresh worker tries to dispatch a DIFFERENT unit_type but
  // SAME unit_id (research-slice/M002/S04) — this is the exact M002/S04
  // forensics symptom. Without the crash-recovery cleanup, the partial
  // unique index blocks the claim.
  const reclaimBeforeRecovery = recordDispatchClaim({
    traceId: "trace-research-attempt",
    workerId,
    milestoneLeaseToken: leaseToken,
    milestoneId: "M002",
    sliceId: "S04",
    unitType: "research-slice",
    unitId: "M002/S04",
  });
  assert.equal(reclaimBeforeRecovery.ok, false, "pre-recovery claim must fail (already_active)");
  if (!reclaimBeforeRecovery.ok) {
    assert.equal(reclaimBeforeRecovery.error, "already_active");
  }

  // Step 3: crash recovery runs. Pre-fix this only writes a journal event
  // and the ledger row STAYS running; post-fix it also releases the row.
  emitCrashRecoveredUnitEnd(base, makeLock("plan-slice", "M002/S04"));

  // Step 4: the released row must now be `failed` so the new claim can
  // succeed.
  const cleared = getLatestForUnit("M002/S04");
  assert.equal(
    cleared?.status,
    "failed",
    "post-recovery: stale running row must be released to status=failed " +
    "(D004 — pre-fix this row would still be 'running' and the next assert fails)",
  );
  assert.equal(cleared?.error_summary, "crash-recovered");

  // Step 5: research-slice can now claim — exactly the unblock that the
  // M002/S04 stuck-loop needed.
  const reclaimAfterRecovery = recordDispatchClaim({
    traceId: "trace-research-after-recovery",
    workerId,
    milestoneLeaseToken: leaseToken,
    milestoneId: "M002",
    sliceId: "S04",
    unitType: "research-slice",
    unitId: "M002/S04",
  });
  assert.equal(
    reclaimAfterRecovery.ok,
    true,
    "post-recovery: dispatch claim for the same unit_id with a different unit_type must succeed",
  );
});

test("D004 — emitCrashRecoveredUnitEnd is fail-soft when no ledger row exists", (t) => {
  // The crash-recovery contract is "never throw past this boundary."
  // If a worker died before any dispatch claim landed, the ledger
  // cleanup must be a silent no-op.
  const base = makeBase();
  t.after(() => cleanup(base));
  seed(base);

  // No claim recorded — call recovery anyway.
  assert.doesNotThrow(() => {
    emitCrashRecoveredUnitEnd(base, makeLock("plan-slice", "M002/S99"));
  });

  assert.equal(getLatestForUnit("M002/S99"), null);
});

test("emitCrashRecoveredUnitEnd ignores starting/bootstrap units", (t) => {
  // Pre-existing contract: 'starting' bootstrap entries are skipped.
  // Post-fix must preserve this guard so we don't accidentally release
  // unrelated rows when a bootstrap lock is recovered.
  const base = makeBase();
  t.after(() => cleanup(base));
  const { workerId, leaseToken } = seed(base);

  const claim = recordDispatchClaim({
    traceId: "trace-real-unit",
    workerId,
    milestoneLeaseToken: leaseToken,
    milestoneId: "M002",
    sliceId: "S04",
    unitType: "plan-slice",
    unitId: "M002/S04",
  });
  assert.equal(claim.ok, true);
  if (!claim.ok) return;
  markRunning(claim.dispatchId);

  // Recovery for a 'starting' lock must NOT touch the unrelated row.
  emitCrashRecoveredUnitEnd(base, {
    pid: 1,
    startedAt: new Date().toISOString(),
    unitType: "starting",
    unitId: "bootstrap",
    unitStartedAt: new Date().toISOString(),
  });

  const row = getLatestForUnit("M002/S04");
  assert.equal(row?.status, "running", "starting/bootstrap recovery must not release real dispatch rows");
});
