/**
 * D004 reproduce-and-prevent regression test for M001/S05/T04:
 * `markFailed` truthy-null bug at db/unit-dispatches.ts:269-271.
 *
 * Pre-fix code:
 *   const nextRunIso = opts.retryAfterMs
 *     ? new Date(now.getTime() + opts.retryAfterMs).toISOString()
 *     : null;
 *
 * `retryAfterMs === 0` (caller asks for immediate retry) is falsy, so the
 * truthy branch is skipped and `next_run_at` is set to NULL. Worse, the
 * `:retry_after_ms` bind uses `opts.retryAfterMs ?? null` (correct), but
 * the audit-event payload also coerces `?? null` — so the stuck-detector
 * and forensics both see "no retry scheduled" when the caller actually
 * requested one.
 *
 * Fix: explicit nullish-aware check (`typeof opts.retryAfterMs === 'number'`)
 * so 0 is treated as "schedule retry now" and undefined/null as "no retry".
 *
 * Direct-import only (MEM009): pulled from `db/unit-dispatches.ts` and
 * `gsd-db.ts`, never via a barrel.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  openDatabase,
  closeDatabase,
  insertMilestone,
  _getAdapter,
} from "../gsd-db.ts";
import { registerAutoWorker } from "../db/auto-workers.ts";
import { claimMilestoneLease } from "../db/milestone-leases.ts";
import {
  recordDispatchClaim,
  markFailed,
  getLatestForUnit,
} from "../db/unit-dispatches.ts";

function makeBase(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-markfailed-"));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  return base;
}

function cleanup(base: string): void {
  try { closeDatabase(); } catch { /* noop */ }
  try { rmSync(base, { recursive: true, force: true }); } catch { /* noop */ }
}

test("markFailed(retryAfterMs === 0) schedules an immediate retry — next_run_at is set, retry_after_ms is 0 (NOT null)", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));

  // File-backed DB so registerAutoWorker / claimMilestoneLease / etc. operate
  // against a normal initialized schema (matches the established pattern in
  // unit-dispatches.test.ts).
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "T04 fixture", status: "active" });
  const workerId = registerAutoWorker({ projectRootRealpath: base });
  const lease = claimMilestoneLease(workerId, "M001");
  assert.equal(lease.ok, true, "milestone lease must be claimable");
  if (!lease.ok) throw new Error("expected test lease");

  const claim = recordDispatchClaim({
    traceId: "trace-t04",
    turnId: "turn-t04",
    workerId,
    milestoneLeaseToken: lease.token,
    milestoneId: "M001",
    unitType: "plan-slice",
    unitId: "M001/T04",
  });
  assert.equal(claim.ok, true, "fixture dispatch must be claimed");
  if (!claim.ok) throw new Error("expected ok claim");

  const beforeMs = Date.now();
  markFailed(claim.dispatchId, {
    errorSummary: "synthetic immediate-retry test",
    retryAfterMs: 0,
  });

  const row = getLatestForUnit("M001/T04");
  assert.ok(row, "row must still exist after markFailed");
  assert.equal(row!.status, "failed", "status must be 'failed'");

  // (a) retry_after_ms must be 0 (number), NOT null. Pre-fix this is null
  //     because the truthy branch is skipped and the bind uses ?? null.
  assert.equal(
    row!.retry_after_ms,
    0,
    `retry_after_ms must be 0 (got ${row!.retry_after_ms}) — caller requested immediate retry`,
  );

  // (b) next_run_at must be a valid ISO string near "now". Pre-fix this is
  //     null because `opts.retryAfterMs` (0) is falsy and the ternary picks
  //     the null branch.
  assert.notEqual(
    row!.next_run_at,
    null,
    "next_run_at must NOT be null when retryAfterMs === 0 — caller requested immediate retry",
  );
  assert.equal(typeof row!.next_run_at, "string", "next_run_at must be an ISO string");
  const nextRunMs = Date.parse(row!.next_run_at as string);
  assert.ok(
    Number.isFinite(nextRunMs),
    `next_run_at must parse as a valid date (got ${row!.next_run_at})`,
  );
  // Allow a 5s tolerance window — covers slow test runners and clock skew.
  const drift = Math.abs(nextRunMs - beforeMs);
  assert.ok(
    drift < 5_000,
    `next_run_at must be ~now (drift=${drift}ms, beforeMs=${beforeMs}, nextRunMs=${nextRunMs})`,
  );

  // (c) Audit event payload must record retryAfterMs: 0 (NOT null) so the
  //     stuck-detector forensics sees the requested retry. The function
  //     inserts a 'dispatch-failed' event for this dispatchId — find it.
  const db = _getAdapter()!;
  const event = db.prepare(
    `SELECT payload_json
     FROM audit_events
     WHERE trace_id = :trace_id AND type = 'dispatch-failed'
     ORDER BY ts DESC LIMIT 1`,
  ).get({ ":trace_id": String(claim.dispatchId) }) as
    | { payload_json: string }
    | undefined;
  assert.ok(event, "dispatch-failed audit event must exist");
  const payload = JSON.parse(event!.payload_json) as {
    dispatchId?: number;
    retryAfterMs?: number | null;
  };
  assert.equal(
    payload.retryAfterMs,
    0,
    `audit event payload.retryAfterMs must be 0 (got ${JSON.stringify(payload.retryAfterMs)})`,
  );
});

test("markFailed with no retryAfterMs leaves next_run_at null and retry_after_ms null (regression guard for the no-retry path)", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));

  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "T04 fixture", status: "active" });
  const workerId = registerAutoWorker({ projectRootRealpath: base });
  const lease = claimMilestoneLease(workerId, "M001");
  assert.equal(lease.ok, true);
  if (!lease.ok) throw new Error("expected test lease");

  const claim = recordDispatchClaim({
    traceId: "trace-t04-noretry",
    workerId,
    milestoneLeaseToken: lease.token,
    milestoneId: "M001",
    unitType: "plan-slice",
    unitId: "M001/T04-noretry",
  });
  assert.equal(claim.ok, true);
  if (!claim.ok) throw new Error("expected ok claim");

  markFailed(claim.dispatchId, { errorSummary: "no retry requested" });

  const row = getLatestForUnit("M001/T04-noretry");
  assert.ok(row);
  assert.equal(row!.status, "failed");
  assert.equal(row!.retry_after_ms, null, "no retry → retry_after_ms must be null");
  assert.equal(row!.next_run_at, null, "no retry → next_run_at must be null");
});
