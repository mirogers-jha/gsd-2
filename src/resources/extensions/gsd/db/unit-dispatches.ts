// gsd-2 + Unit dispatch ledger (DB-backed coordination, Phase B)
//
// Records every auto-mode unit dispatch (plan-slice, run-task, summarize, …)
// with worker_id, fencing token, status lifecycle, and retry metadata. The
// ledger is the substrate Phase C will consume to migrate stuck-state.json
// and paused-session.json out of the runtime/ directory.
//
// Codex review MEDIUM B2: partial unique index
//   idx_unit_dispatches_active_per_unit ON unit_dispatches(unit_id)
//   WHERE status IN ('claimed','running')
// enforces that two workers cannot simultaneously claim the same unit.
// recordDispatchClaim relies on the index to fail fast at INSERT time
// rather than racing in application code.

import { randomUUID } from "node:crypto";

import {
  _getAdapter,
  isDbAvailable,
  transaction,
  insertAuditEvent,
} from "../gsd-db.js";

export type DispatchStatus =
  | "pending"
  | "claimed"
  | "running"
  | "completed"
  | "failed"
  | "stuck"
  | "canceled"
  | "paused"
  // M002/S04/T03 — additive terminal status. Mirrors the `failed`/`completed`
  // class semantically (the dispatch is over) but distinguishes
  // "model policy denied this dispatch before prompt-send" from a
  // genuine `failed` so consecutive-error budget bookkeeping in
  // auto/loop.ts can preserve its 3-strike intent (see RESEARCH §T03).
  // No schema migration: `status` is `TEXT` in db-coordination-schema.ts
  // (the partial-unique index is scoped to `('claimed','running')`, so
  // policy-blocked terminal rows do not collide with future claims).
  | "policy-blocked";

export interface UnitDispatchRow {
  id: number;
  trace_id: string;
  turn_id: string | null;
  worker_id: string;
  milestone_lease_token: number;
  milestone_id: string;
  slice_id: string | null;
  task_id: string | null;
  unit_type: string;
  unit_id: string;
  status: DispatchStatus;
  attempt_n: number;
  started_at: string;
  ended_at: string | null;
  exit_reason: string | null;
  error_summary: string | null;
  verification_evidence_id: number | null;
  next_run_at: string | null;
  retry_after_ms: number | null;
  max_attempts: number;
  last_error_code: string | null;
  last_error_at: string | null;
}

export interface RecordClaimInput {
  traceId: string;
  turnId?: string | null;
  workerId: string;
  milestoneLeaseToken: number;
  milestoneId: string;
  sliceId?: string | null;
  taskId?: string | null;
  unitType: string;
  unitId: string;
  /**
   * Attempt number for this unit. Callers should compute this from the
   * most recent prior dispatch for the same unit_id (use
   * getRecentForUnit() then add 1). Defaults to 1 for fresh claims.
   */
  attemptN?: number;
  /** Per-attempt cap; defaults to 3. */
  maxAttempts?: number;
}

export type RecordClaimResult =
  | { ok: true; dispatchId: number }
  | { ok: false; error: "already_active"; existingId: number; existingStatus: DispatchStatus; existingWorker: string }
  | { ok: false; error: "stale_lease"; milestoneId: string; workerId: string; milestoneLeaseToken: number };

function isAlreadyActiveConstraintError(err: unknown): boolean {
  const code =
    err && typeof err === "object" && "code" in err
      ? String((err as { code?: unknown }).code ?? "")
      : "";
  const msg = err instanceof Error ? err.message : String(err);
  if (/\bFOREIGN KEY\b/i.test(msg)) {
    return false;
  }

  if (code === "SQLITE_CONSTRAINT" || code === "SQLITE_CONSTRAINT_UNIQUE") {
    return true;
  }

  return /\bUNIQUE\b|\bconstraint failed\b/i.test(msg);
}

/**
 * Insert a new dispatch row in `claimed` state. Atomic guard against
 * double-claim (B2): the partial unique index
 * idx_unit_dispatches_active_per_unit refuses the INSERT if any row for
 * the same unit_id already has status IN ('claimed','running').
 */
export function recordDispatchClaim(input: RecordClaimInput): RecordClaimResult {
  if (!isDbAvailable()) {
    throw new Error("recordDispatchClaim: DB unavailable");
  }
  const now = new Date().toISOString();

  return transaction((): RecordClaimResult => {
    const db = _getAdapter()!;

    const lease = db.prepare(
      `SELECT fencing_token
       FROM milestone_leases
       WHERE milestone_id = :milestone_id
         AND worker_id = :worker_id
         AND fencing_token = :token
         AND status = 'held'`,
    ).get({
      ":milestone_id": input.milestoneId,
      ":worker_id": input.workerId,
      ":token": input.milestoneLeaseToken,
    }) as { fencing_token: number } | undefined;
    if (!lease) {
      return {
        ok: false,
        error: "stale_lease",
        milestoneId: input.milestoneId,
        workerId: input.workerId,
        milestoneLeaseToken: input.milestoneLeaseToken,
      };
    }

    try {
      const result = db.prepare(
        `INSERT INTO unit_dispatches (
          trace_id, turn_id, worker_id, milestone_lease_token,
          milestone_id, slice_id, task_id,
          unit_type, unit_id, status, attempt_n,
          started_at, max_attempts
        ) VALUES (
          :trace_id, :turn_id, :worker_id, :milestone_lease_token,
          :milestone_id, :slice_id, :task_id,
          :unit_type, :unit_id, 'claimed', :attempt_n,
          :started_at, :max_attempts
        )`,
      ).run({
        ":trace_id": input.traceId,
        ":turn_id": input.turnId ?? null,
        ":worker_id": input.workerId,
        ":milestone_lease_token": input.milestoneLeaseToken,
        ":milestone_id": input.milestoneId,
        ":slice_id": input.sliceId ?? null,
        ":task_id": input.taskId ?? null,
        ":unit_type": input.unitType,
        ":unit_id": input.unitId,
        ":attempt_n": input.attemptN ?? 1,
        ":started_at": now,
        ":max_attempts": input.maxAttempts ?? 3,
      });
      const id = Number((result as { lastInsertRowid?: number | bigint }).lastInsertRowid ?? 0);

      insertAuditEvent({
        eventId: randomUUID(),
        traceId: input.traceId,
        turnId: input.turnId ?? undefined,
        category: "orchestration",
        type: "dispatch-claimed",
        ts: now,
        payload: {
          dispatchId: id,
          unitId: input.unitId,
          unitType: input.unitType,
          workerId: input.workerId,
          attemptN: input.attemptN ?? 1,
        },
      });

      return { ok: true, dispatchId: id };
    } catch (err) {
      if (!isAlreadyActiveConstraintError(err)) throw err;

      // Partial unique index rejected the INSERT — surface the existing
      // active dispatch so callers can decide what to do.
      const existing = db.prepare(
        `SELECT id, status, worker_id FROM unit_dispatches
         WHERE unit_id = :unit_id AND status IN ('claimed','running')
         ORDER BY id DESC LIMIT 1`,
      ).get({ ":unit_id": input.unitId }) as { id: number; status: DispatchStatus; worker_id: string } | undefined;

      return {
        ok: false,
        error: "already_active",
        existingId: existing?.id ?? 0,
        existingStatus: existing?.status ?? "claimed",
        existingWorker: existing?.worker_id ?? "unknown",
      };
    }
  });
}

/** Transition a `claimed` dispatch into `running`. */
export function markRunning(dispatchId: number): void {
  if (!isDbAvailable()) return;
  const db = _getAdapter()!;
  db.prepare(
    `UPDATE unit_dispatches SET status = 'running'
     WHERE id = :id AND status = 'claimed'`,
  ).run({ ":id": dispatchId });
}

export interface CompleteOpts {
  verificationEvidenceId?: number | null;
  exitReason?: string;
}

/** Transition a dispatch into `completed`. */
export function markCompleted(dispatchId: number, opts?: CompleteOpts): void {
  if (!isDbAvailable()) return;
  const now = new Date().toISOString();
  const db = _getAdapter()!;
  let changes = 0;
  transaction(() => {
    const result = db.prepare(
      `UPDATE unit_dispatches
       SET status = 'completed', ended_at = :ended_at,
           exit_reason = :exit_reason,
           verification_evidence_id = :evidence_id
       WHERE id = :id
         AND status IN ('claimed','running')`,
    ).run({
      ":id": dispatchId,
      ":ended_at": now,
      ":exit_reason": opts?.exitReason ?? null,
      ":evidence_id": opts?.verificationEvidenceId ?? null,
    });
    changes =
      typeof (result as { changes?: unknown }).changes === "number"
        ? (result as { changes: number }).changes
        : 0;
  });
  if (changes < 1) return;
  insertAuditEvent({
    eventId: randomUUID(),
    traceId: dispatchId.toString(),
    category: "orchestration",
    type: "dispatch-completed",
    ts: now,
    payload: { dispatchId },
  });
}

export interface FailureOpts {
  errorSummary: string;
  errorCode?: string;
  /** Backoff before next attempt (used by stuck-detector retry suppression). */
  retryAfterMs?: number;
}

/** Transition a dispatch into `failed`, optionally scheduling a retry. */
export function markFailed(dispatchId: number, opts: FailureOpts): void {
  if (!isDbAvailable()) return;
  const now = new Date();
  const nowIso = now.toISOString();
  // Explicit nullish-aware check: `retryAfterMs === 0` (immediate retry)
  // must NOT be coerced to "no retry" by a truthy ternary. Only treat
  // undefined/null as the no-retry signal. (D004 / M001 S05 T04.)
  const nextRunIso = (typeof opts.retryAfterMs === "number")
    ? new Date(now.getTime() + opts.retryAfterMs).toISOString()
    : null;
  const db = _getAdapter()!;
  let changes = 0;
  transaction(() => {
    const result = db.prepare(
      `UPDATE unit_dispatches
       SET status = 'failed', ended_at = :ended_at,
           error_summary = :error_summary,
           last_error_code = :last_error_code,
           last_error_at = :last_error_at,
           retry_after_ms = :retry_after_ms,
           next_run_at = :next_run_at
       WHERE id = :id
         AND status IN ('claimed','running')`,
    ).run({
      ":id": dispatchId,
      ":ended_at": nowIso,
      ":error_summary": opts.errorSummary,
      ":last_error_code": opts.errorCode ?? null,
      ":last_error_at": nowIso,
      ":retry_after_ms": opts.retryAfterMs ?? null,
      ":next_run_at": nextRunIso,
    });
    changes =
      typeof (result as { changes?: unknown }).changes === "number"
        ? (result as { changes: number }).changes
        : 0;
  });
  if (changes < 1) return;
  insertAuditEvent({
    eventId: randomUUID(),
    traceId: dispatchId.toString(),
    category: "orchestration",
    type: "dispatch-failed",
    ts: nowIso,
    payload: { dispatchId, errorSummary: opts.errorSummary, retryAfterMs: opts.retryAfterMs ?? null },
  });
}

export interface PolicyBlockedOpts {
  /**
   * One-line per-model deny-reasons summary. Encoded into `error_summary`
   * as plain text (NOT JSON-stringified) so existing forensics queries
   * `SELECT error_summary FROM unit_dispatches WHERE status='policy-blocked'`
   * surface the human-readable reason directly. Same convention as
   * `markFailed`'s `errorSummary` field.
   */
  errorSummary: string;
}

/**
 * Transition a dispatch into `policy-blocked` (M002/S04/T03).
 *
 * Pre-fix, `auto/loop.ts:857-862` deliberately SKIPPED settling
 * `ModelPolicyDispatchBlockedError` so the row stayed in `running`
 * forever (or until cleanup). RESEARCH §T03 documented this as the
 * race-window bug. The fix routes those errors through the new helper
 * `settleDispatchPolicyBlocked` which calls into this writer.
 *
 * Mirrors `markFailed` shape exactly except: status terminal value is
 * `'policy-blocked'`, no retry scheduling (policy denials don't burn
 * the 3-strike budget), and the audit event type is
 * `dispatch-policy-blocked`.
 */
export function markPolicyBlocked(dispatchId: number, opts: PolicyBlockedOpts): void {
  if (!isDbAvailable()) return;
  const nowIso = new Date().toISOString();
  const db = _getAdapter()!;
  let changes = 0;
  transaction(() => {
    const result = db.prepare(
      `UPDATE unit_dispatches
       SET status = 'policy-blocked', ended_at = :ended_at,
           error_summary = :error_summary,
           last_error_code = :last_error_code,
           last_error_at = :last_error_at
       WHERE id = :id
         AND status IN ('claimed','running')`,
    ).run({
      ":id": dispatchId,
      ":ended_at": nowIso,
      ":error_summary": opts.errorSummary,
      ":last_error_code": "ModelPolicyDispatchBlockedError",
      ":last_error_at": nowIso,
    });
    changes =
      typeof (result as { changes?: unknown }).changes === "number"
        ? (result as { changes: number }).changes
        : 0;
  });
  if (changes < 1) return;
  insertAuditEvent({
    eventId: randomUUID(),
    traceId: dispatchId.toString(),
    category: "orchestration",
    type: "dispatch-policy-blocked",
    ts: nowIso,
    payload: { dispatchId, errorSummary: opts.errorSummary },
  });
}

/** Transition a dispatch into `stuck`. */
export function markStuck(dispatchId: number, reason: string): void {
  if (!isDbAvailable()) return;
  const now = new Date().toISOString();
  const db = _getAdapter()!;
  const result = transaction(() => {
    return db.prepare(
      `UPDATE unit_dispatches
       SET status = 'stuck', ended_at = :ended_at, exit_reason = :reason
       WHERE id = :id
         AND status IN ('claimed','running')`,
    ).run({ ":id": dispatchId, ":ended_at": now, ":reason": reason });
  });
  const changes =
    typeof (result as { changes?: unknown }).changes === "number"
      ? (result as { changes: number }).changes
      : 0;
  if (changes <= 0) return;
  insertAuditEvent({
    eventId: randomUUID(),
    traceId: dispatchId.toString(),
    category: "orchestration",
    type: "dispatch-stuck",
    ts: now,
    payload: { dispatchId, reason },
  });
}

/** Transition a dispatch into `paused`. */
export function markPaused(dispatchId: number): void {
  if (!isDbAvailable()) return;
  const now = new Date().toISOString();
  const db = _getAdapter()!;
  db.prepare(
    `UPDATE unit_dispatches
     SET status = 'paused', ended_at = :ended_at
     WHERE id = :id AND status IN ('claimed','running')`,
  ).run({ ":id": dispatchId, ":ended_at": now });
}

/** Transition a dispatch into `canceled`. */
export function markCanceled(dispatchId: number, reason: string): void {
  if (!isDbAvailable()) return;
  const now = new Date().toISOString();
  const db = _getAdapter()!;
  db.prepare(
    `UPDATE unit_dispatches
     SET status = 'canceled', ended_at = :ended_at, exit_reason = :reason
     WHERE id = :id AND status IN ('pending','claimed','running')`,
  ).run({ ":id": dispatchId, ":ended_at": now, ":reason": reason });
}

/**
 * Best-effort signal/crash cleanup: cancel the latest active dispatch owned by
 * a worker when the process is exiting before the normal loop can settle it.
 */
export function markLatestActiveForWorkerCanceled(workerId: string, reason: string): boolean {
  if (!isDbAvailable()) return false;
  const now = new Date().toISOString();
  const db = _getAdapter()!;
  const result = transaction(() => {
    return db.prepare(
      `UPDATE unit_dispatches
       SET status = 'canceled', ended_at = :ended_at, exit_reason = :reason
       WHERE id = (
         SELECT id FROM unit_dispatches
         WHERE worker_id = :worker_id
           AND status IN ('pending','claimed','running')
         ORDER BY id DESC
         LIMIT 1
       )`,
    ).run({
      ":ended_at": now,
      ":reason": reason,
      ":worker_id": workerId,
    });
  });
  const changes =
    typeof (result as { changes?: unknown }).changes === "number"
      ? (result as { changes: number }).changes
      : 0;
  if (changes <= 0) return false;
  insertAuditEvent({
    eventId: randomUUID(),
    traceId: workerId,
    category: "orchestration",
    type: "dispatch-canceled",
    ts: now,
    payload: { workerId, reason },
  });
  return true;
}

/**
 * Mark every active (`claimed`/`running`) dispatch row for `unitId` as
 * `failed` with the given reason. Returns the number of rows updated.
 *
 * Used by crash recovery to release dispatches whose owning worker died
 * mid-flight. Without this cleanup, the partial unique index
 * `idx_unit_dispatches_active_per_unit` (on `unit_id` only — NOT
 * `unit_type`+`unit_id`) silently blocks ALL future dispatches sharing
 * the same `unit_id`, including dispatches of a different `unit_type`.
 *
 * Concrete example reproduced in the wild (M002/S04 stuck-loop forensics):
 * a crashed `plan-slice/M002/S04` left an `unit_dispatches` row with
 * status='running'; subsequent dispatches of `research-slice/M002/S04`
 * silently failed the dispatch-claim and the loop hit the
 * "derived 3 consecutive times without progress" guard with no usable
 * diagnostic. The journal showed `iteration-start → dispatch-match → ø`
 * for 4 consecutive iterations.
 */
export function markActiveForUnitFailed(unitId: string, reason: string): number {
  if (!isDbAvailable()) return 0;
  const now = new Date().toISOString();
  const db = _getAdapter()!;
  let changes = 0;
  let updatedIds: number[] = [];
  transaction(() => {
    // Snapshot the IDs first so we can audit-log each row individually.
    updatedIds = (db.prepare(
      `SELECT id FROM unit_dispatches
       WHERE unit_id = :unit_id AND status IN ('claimed','running')`,
    ).all({ ":unit_id": unitId }) as { id: number }[]).map((r) => r.id);

    if (updatedIds.length === 0) return;

    const result = db.prepare(
      `UPDATE unit_dispatches
       SET status = 'failed', ended_at = :ended_at,
           error_summary = :error_summary,
           exit_reason = :exit_reason
       WHERE unit_id = :unit_id AND status IN ('claimed','running')`,
    ).run({
      ":unit_id": unitId,
      ":ended_at": now,
      ":error_summary": reason,
      ":exit_reason": reason,
    });
    changes =
      typeof (result as { changes?: unknown }).changes === "number"
        ? (result as { changes: number }).changes
        : 0;
  });
  for (const id of updatedIds) {
    insertAuditEvent({
      eventId: randomUUID(),
      traceId: id.toString(),
      category: "orchestration",
      type: "dispatch-failed",
      ts: now,
      payload: { dispatchId: id, unitId, reason, source: "crash-recovery" },
    });
  }
  return changes;
}

/**
 * Fetch the most recent N dispatches for a unit. Used by recordDispatchClaim
 * callers to compute attempt_n and by detect-stuck.ts (B3) to consult
 * retry budget before tripping the stuck verdict.
 */
export function getRecentForUnit(unitId: string, limit = 10): UnitDispatchRow[] {
  if (!isDbAvailable()) return [];
  const db = _getAdapter()!;
  return db.prepare(
    `SELECT * FROM unit_dispatches WHERE unit_id = :unit_id ORDER BY id DESC LIMIT :limit`,
  ).all({ ":unit_id": unitId, ":limit": limit }) as unknown as UnitDispatchRow[];
}

/**
 * Fetch the latest dispatch for a unit, regardless of status. Returns null
 * if the unit has never been dispatched.
 */
export function getLatestForUnit(unitId: string): UnitDispatchRow | null {
  if (!isDbAvailable()) return null;
  const db = _getAdapter()!;
  const row = db.prepare(
    `SELECT * FROM unit_dispatches WHERE unit_id = :unit_id ORDER BY id DESC LIMIT 1`,
  ).get({ ":unit_id": unitId }) as UnitDispatchRow | undefined;
  return row ?? null;
}

/**
 * Phase C — return the most recent unit_id values for a worker, oldest-first.
 *
 * Drop-in replacement for the persistence side of stuck-state.json's
 * `recentUnits` field. The auto-loop uses this to seed loopState.recentUnits
 * on session start so the stuck-detector window survives a session restart
 * (#3704). Returned in oldest-first order to match the in-memory window
 * shape that detect-stuck.ts expects.
 */
export function getRecentUnitKeysForWorker(
  workerId: string,
  limit = 20,
): Array<{ key: string }> {
  if (!isDbAvailable()) return [];
  const db = _getAdapter()!;
  const rows = db.prepare(
    `SELECT unit_id FROM unit_dispatches
     WHERE worker_id = :worker_id
     ORDER BY started_at DESC, id DESC
     LIMIT :limit`,
  ).all({ ":worker_id": workerId, ":limit": limit }) as Array<{ unit_id: string }>;
  // Reverse so callers consume oldest-first (sliding-window semantics).
  return rows.reverse().map((r) => ({ key: r.unit_id }));
}

export function getRecentUnitKeysForProjectRoot(
  projectRootRealpath: string,
  limit = 20,
): Array<{ key: string }> {
  if (!isDbAvailable()) return [];
  const db = _getAdapter()!;
  const rows = db.prepare(
    `SELECT ud.unit_id
     FROM unit_dispatches ud
     INNER JOIN workers w ON w.worker_id = ud.worker_id
     WHERE w.project_root_realpath = :project_root_realpath
     ORDER BY ud.started_at DESC, ud.id DESC
     LIMIT :limit`,
  ).all({
    ":project_root_realpath": projectRootRealpath,
    ":limit": limit,
  }) as Array<{ unit_id: string }>;
  return rows.reverse().map((r) => ({ key: r.unit_id }));
}

/**
 * Fetch dispatches for a milestone filtered by status. Useful for janitors
 * + dashboards.
 */
export function getDispatchesByStatus(
  milestoneId: string,
  status: DispatchStatus,
): UnitDispatchRow[] {
  if (!isDbAvailable()) return [];
  const db = _getAdapter()!;
  return db.prepare(
    `SELECT * FROM unit_dispatches WHERE milestone_id = :mid AND status = :status ORDER BY id`,
  ).all({ ":mid": milestoneId, ":status": status }) as unknown as UnitDispatchRow[];
}
