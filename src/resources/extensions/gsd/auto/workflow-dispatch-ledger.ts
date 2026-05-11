// Project/App: GSD-2
// File Purpose: Best-effort dispatch ledger write helpers for auto-mode loop adapters.

interface DispatchLedgerWriteDeps {
  logWriteFailure: (err: unknown) => void;
}

interface DispatchLedgerFailDeps extends DispatchLedgerWriteDeps {
  markFailed: (dispatchId: number, details: { errorSummary: string }) => void;
}

interface DispatchLedgerCompleteDeps extends DispatchLedgerWriteDeps {
  markCompleted: (dispatchId: number) => void;
}

interface DispatchLedgerPolicyBlockedDeps extends DispatchLedgerWriteDeps {
  markPolicyBlocked: (dispatchId: number, details: { errorSummary: string }) => void;
}

// ─── M002/S04/T03 status-filter audit (for the new `policy-blocked` value) ──
// Per S04-PLAN T03, every `WHERE status IN (...)` filter in the codebase was
// audited before adding `policy-blocked` as a terminal status. Audit
// commands (verbatim from PLAN, run from the repo root):
//   rg -n "status IN \\('claimed'" src/resources/extensions/gsd/
//   rg -n "status IN \\('completed'" src/resources/extensions/gsd/
//   rg -n "status IN \\('failed'" src/resources/extensions/gsd/
//
// Result: every production `status IN (...)` filter targets the
// non-terminal pair `('claimed','running')` (10 hits across
// db-coordination-schema.ts:103 partial-unique index +
// db/unit-dispatches.ts:191/234/287/323/349/434/444 transition guards).
// `policy-blocked` is a TERMINAL status (same class as `failed`/`completed`)
// so widening these guards would be wrong — a policy-blocked row must NOT
// be selectable by claim-attempt or transition-from-running queries.
//
// No edits required. The new `markPolicyBlocked` writer in
// `db/unit-dispatches.ts` itself uses `WHERE id = :id AND status IN
// ('claimed','running')` so it correctly transitions from claimed/running
// to terminal and is a no-op if the row is already terminal.

export function settleDispatchFailed(
  dispatchId: number | null,
  errorSummary: string,
  deps: DispatchLedgerFailDeps,
): boolean {
  if (dispatchId === null) return false;

  try {
    deps.markFailed(dispatchId, { errorSummary });
    return true;
  } catch (err) {
    deps.logWriteFailure(err);
    return false;
  }
}

export function settleDispatchCompleted(
  dispatchId: number | null,
  deps: DispatchLedgerCompleteDeps,
): boolean {
  if (dispatchId === null) return false;

  try {
    deps.markCompleted(dispatchId);
    return true;
  } catch (err) {
    deps.logWriteFailure(err);
    return false;
  }
}

/**
 * Settle an in-flight dispatch as `policy-blocked` (M002/S04/T03).
 *
 * Mirrors `settleDispatchFailed` in shape — best-effort write that returns
 * `true` on success and `false` on no-op (null id) or write failure (logged
 * via `deps.logWriteFailure`). The two helpers share the dispatch-ledger
 * idempotency contract: callers `dispatchSettled = settle*(...) ||
 * dispatchSettled` to ensure double-settle attempts collapse.
 *
 * Pre-fix: `auto/loop.ts:857-862` excluded `ModelPolicyDispatchBlockedError`
 * from `settleDispatchFailed`, leaving the row in `running` until manual
 * cleanup. Post-fix: the blanket catch routes policy-blocked errors here.
 */
export function settleDispatchPolicyBlocked(
  dispatchId: number | null,
  errorSummary: string,
  deps: DispatchLedgerPolicyBlockedDeps,
): boolean {
  if (dispatchId === null) return false;

  try {
    deps.markPolicyBlocked(dispatchId, { errorSummary });
    return true;
  } catch (err) {
    deps.logWriteFailure(err);
    return false;
  }
}
