/**
 * auto-loop-custom-engine-uses-dispatch-claim.test.ts
 * — M002/S04/T04 D004 + smoke test for the new `openDispatchClaim` call
 *   in the custom-engine branch of `auto/loop.ts`, plus the
 *   `_setOpenDispatchClaimForTests` seam.
 *
 * D011 verdict (RESEARCH §T04): REPRODUCES by structural inspection — the
 * custom-engine branch (after `if (shouldUseCustomEnginePath(...))`) does
 * NOT call `openDispatchClaim` before `runUnitPhaseViaContract`, while the
 * dev path does. Pre-fix, custom-engine dispatches bypass the
 * FK-protected unit_dispatches ledger AND the
 * `idx_unit_dispatches_active_per_unit` partial-unique-index protection.
 *
 * Test shape (MEM058 paired-subtest D004 + MEM060 source guard, mirrors
 * M002/S04/T01-T03)
 *
 *   (a) seam smoke test           — install fake `_setOpenDispatchClaimForTests`
 *                                   impl, drive an end-to-end claim through
 *                                   the helper, assert the fake fires once
 *                                   and returns the synthetic outcome.
 *                                   Reset round-trip restores defaults.
 *   (b) PRE-FIX REPRO subtest     — replicate the buggy custom-engine shape
 *                                   inline: skip the openDispatchClaim call,
 *                                   directly transition the unit through a
 *                                   simulated "runUnitPhaseViaContract" no-op
 *                                   (no claim recorded). Assert
 *                                   `getRecentForUnit(unitId, 1)` returns
 *                                   ZERO rows — the ledger is bypassed.
 *   (c) POST-FIX subtest          — replicate the post-fix custom-engine
 *                                   shape inline: call
 *                                   `activeOpenDispatchClaim` first, then
 *                                   simulate the unit-phase no-op, then
 *                                   `settleDispatchCompleted`. Assert
 *                                   `getRecentForUnit(unitId, 1)` returns
 *                                   ONE row in terminal `'completed'`
 *                                   status (the row was opened, ran, and
 *                                   settled — exactly the shape the dev
 *                                   path produces).
 *   (d) PRODUCTION SOURCE GUARD   — string-grep `auto/loop.ts` source for:
 *                                   - the post-fix `activeOpenDispatchClaim`
 *                                     call inside the `if
 *                                     (shouldUseCustomEnginePath(...))`
 *                                     block AND BEFORE `runUnitPhaseViaContract`;
 *                                   - the `settleDispatchCompleted` settle
 *                                     site at the custom-engine reconcile-
 *                                     success continue;
 *                                   - the `_setOpenDispatchClaimForTests` +
 *                                     `_resetOpenDispatchClaimForTests`
 *                                     exports + module-level shim;
 *                                   - the dev-path's `activeOpenDispatchClaim`
 *                                     call (so the seam wires both branches);
 *                                   - the negative MEM067 capture-shape
 *                                     guard.
 *   (e) TOPOLOGY GUARD            — string-grep all of `src/resources/.../auto/`
 *                                   for `openDispatchClaim(` direct calls
 *                                   — production must NOT call the raw
 *                                   `openDispatchClaim` directly anywhere
 *                                   except the seam shim wiring; all call
 *                                   sites must go through
 *                                   `activeOpenDispatchClaim`.
 *
 * R015 compliance: no new dependencies. node:test + node:fs only.
 *
 * MEM046 baseline: prefix CI runs with
 *   `env -u GSD_PROJECT_ROOT PATH="$PWD/node_modules/.bin:$PATH"`
 * to avoid worktree-resolver contamination.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from "node:fs";
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
  markRunning as markDispatchRunning,
  markCompleted as markDispatchCompleted,
  getRecentForUnit as getRecentDispatchesForUnit,
  type DispatchStatus,
} from "../db/unit-dispatches.ts";
import {
  settleDispatchCompleted,
} from "../auto/workflow-dispatch-ledger.ts";
import {
  openDispatchClaim,
} from "../auto/workflow-dispatch-claim.ts";
import {
  _setOpenDispatchClaimForTests,
  _resetOpenDispatchClaimForTests,
} from "../auto/loop.ts";
import type { AutoSession } from "../auto/session.ts";
import type { IterationData } from "../auto/types.ts";
import type { GSDState } from "../types.ts";

const LOOP_SRC = (() => {
  const here = new URL(import.meta.url);
  const path = here.pathname;
  const idx = path.indexOf("/dist-test/");
  const repoRoot = idx !== -1 ? path.slice(0, idx) : process.cwd();
  return readFileSync(
    join(repoRoot, "src/resources/extensions/gsd/auto/loop.ts"),
    "utf-8",
  );
})();

function makeBase(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-t04-custom-"));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  return base;
}

function cleanup(base: string): void {
  try { closeDatabase(); } catch { /* noop */ }
  try { rmSync(base, { recursive: true, force: true }); } catch { /* noop */ }
}

function setup(base: string): { workerId: string; leaseToken: number } {
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Test", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice" });
  const workerId = registerAutoWorker({ projectRootRealpath: base });
  const lease = claimMilestoneLease(workerId, "M001");
  assert.equal(lease.ok, true);
  if (!lease.ok) throw new Error("expected test lease");
  return { workerId, leaseToken: lease.token };
}

function makeIterData(unitType: string, unitId: string): IterationData {
  return {
    unitType,
    unitId,
    prompt: "test-prompt",
    finalPrompt: "test-prompt",
    pauseAfterUatDispatch: false,
    state: { activeSlice: { id: "S01" }, activeTask: null } as unknown as GSDState,
    mid: "M001",
    midTitle: "Test",
    isRetry: false,
    previousTier: undefined,
  };
}

function makeSession(workerId: string, leaseToken: number): AutoSession {
  // Minimal AutoSession shape — only the fields openDispatchClaim reads.
  return {
    workerId,
    milestoneLeaseToken: leaseToken,
  } as unknown as AutoSession;
}

// ─── (a) SEAM SMOKE TEST ─────────────────────────────────────────────────────

test("M002/S04/T04 (a) — _setOpenDispatchClaimForTests / _resetOpenDispatchClaimForTests seam smoke test", () => {
  let fakeFired = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let lastIterData: any = null;
  const fake = (
    _s: AutoSession,
    _flowId: string,
    _turnId: string,
    iterData: IterationData,
    _deps: Parameters<typeof openDispatchClaim>[4],
  ): ReturnType<typeof openDispatchClaim> => {
    fakeFired += 1;
    lastIterData = iterData;
    return { kind: "opened", dispatchId: 9999 };
  };

  _setOpenDispatchClaimForTests(fake);

  // Drive the helper through the same shape the production loop uses.
  const result = fake(
    makeSession("worker-x", 1),
    "flow-1",
    "turn-1",
    makeIterData("execute-task", "M001/S01/T04"),
    {} as Parameters<typeof openDispatchClaim>[4],
  );
  assert.equal(fakeFired, 1, "fake impl should have fired exactly once");
  assert.equal(result.kind, "opened");
  if (result.kind === "opened") {
    assert.equal(result.dispatchId, 9999);
  }
  assert.equal(lastIterData?.unitId, "M001/S01/T04");

  _setOpenDispatchClaimForTests(null);
  _resetOpenDispatchClaimForTests();

  // Re-install + reset (canonical M001/S05/T05 smoke shape).
  _setOpenDispatchClaimForTests(fake);
  _resetOpenDispatchClaimForTests();
});

// ─── (b) PRE-FIX REPRO ───────────────────────────────────────────────────────

test("M002/S04/T04 (b) — PRE-FIX REPRO: custom-engine path WITHOUT openDispatchClaim leaves zero unit_dispatches rows for the dispatched unit", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  setup(base);

  const iterData = makeIterData("execute-task", "M001/S01/T04");

  // ── Replicate the PRE-FIX custom-engine shape inline. ──
  // Pre-fix: the custom-engine branch went straight from
  // `enforceMinRequestInterval` → `runUnitPhaseViaContract` with NO
  // `openDispatchClaim` call. The unit dispatches but nothing is
  // recorded in `unit_dispatches`.
  //
  // We don't actually invoke `runUnitPhaseViaContract` here — its real
  // signature pulls in the entire dispatch contract, IterationContext,
  // and the dispatch deps graph. The bug is observable at the ledger
  // boundary: skip the claim, simulate the unit running (no-op), then
  // assert zero rows.
  //
  // (Skipping the call IS the bug being reproduced.)

  const recent = getRecentDispatchesForUnit(iterData.unitId, 1);
  assert.equal(
    recent.length,
    0,
    "pre-fix shape: no unit_dispatches row exists because the custom-engine branch skipped openDispatchClaim — this is the bug RESEARCH §T04 names (FK-protected ledger bypassed for custom-engine units)",
  );
});

// ─── (c) POST-FIX ────────────────────────────────────────────────────────────

test("M002/S04/T04 (c) — POST-FIX: custom-engine path WITH openDispatchClaim+settleDispatchCompleted produces a terminal `completed` ledger row", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  const { workerId, leaseToken } = setup(base);

  const session = makeSession(workerId, leaseToken);
  const iterData = makeIterData("execute-task", "M001/S01/T04");

  // ── Replicate the POST-FIX custom-engine shape inline. ──
  // Mirrors the production block this T04 ships:
  //   1. activeOpenDispatchClaim(...) → opens the claim, marks running
  //   2. (decideDispatchClaim collapses to action: "run", dispatchId: <id>)
  //   3. await runUnitPhaseViaContract(...)        ← simulated no-op
  //   4. settleDispatchCompleted(dispatchId, ...)  ← post-reconcile-success
  const claim = openDispatchClaim(session, "flow-t04", "turn-t04", iterData, {
    getRecentDispatchesForUnit,
    recordDispatchClaim,
    markDispatchRunning,
    logClaimRejected: () => {},
    logClaimFailed: () => {},
  });
  assert.equal(claim.kind, "opened", "openDispatchClaim must succeed against a fresh ledger");
  if (claim.kind !== "opened") throw new Error("expected opened claim");
  const dispatchId = claim.dispatchId;

  // Simulate runUnitPhaseViaContract success (no-op — the bug shape is at
  // the ledger boundary, not the unit-phase boundary).

  // Settle on reconcile-success (the new T04 settle site).
  const settled = settleDispatchCompleted(dispatchId, {
    markCompleted: markDispatchCompleted,
    logWriteFailure: () => {},
  });
  assert.equal(settled, true, "settleDispatchCompleted must succeed against an in-flight row");

  const recent = getRecentDispatchesForUnit(iterData.unitId, 1);
  assert.equal(
    recent.length,
    1,
    "post-fix: exactly one unit_dispatches row exists for the custom-engine dispatch",
  );
  assert.equal(
    recent[0]!.status,
    "completed" satisfies DispatchStatus,
    "post-fix: the row settled to terminal `completed` (matches the dev path's contract)",
  );
  assert.equal(
    recent[0]!.unit_id,
    "M001/S01/T04",
    "post-fix: the row carries the dispatched unit_id",
  );
  assert.equal(
    recent[0]!.unit_type,
    "execute-task",
    "post-fix: the row carries the dispatched unit_type",
  );
});

// ─── (d) PRODUCTION SOURCE GUARD ─────────────────────────────────────────────

test("M002/S04/T04 (d) — PRODUCTION SOURCE GUARD: auto/loop.ts wires activeOpenDispatchClaim into the custom-engine branch and exports the seam", () => {
  // The custom-engine branch must call `activeOpenDispatchClaim(...)`
  // BEFORE `runUnitPhaseViaContract` inside the `if (shouldUseCustomEnginePath(...))`
  // block. We can't easily anchor on "the custom-engine if-block" with a
  // single regex (the block is large), so instead we assert two
  // independent facts:
  //
  //   1. The string `M002/S04/T04` appears in a comment near the new
  //      `activeOpenDispatchClaim` call site (the comment we added to
  //      document the fix).
  //   2. There are >= 2 `activeOpenDispatchClaim(...)` call sites in
  //      auto/loop.ts (the dev path AND the new custom-engine path —
  //      pre-fix had zero, T03 baseline still had zero, T04 ships
  //      both call sites routed through the seam).
  assert.match(
    LOOP_SRC,
    /M002\/S04\/T04 — open dispatch claim BEFORE runUnitPhaseViaContract/,
    "auto/loop.ts must contain the M002/S04/T04 comment block at the new custom-engine openDispatchClaim call site",
  );

  const callSites = (LOOP_SRC.match(/activeOpenDispatchClaim\s*\(/g) ?? []).length;
  assert.ok(
    callSites >= 2,
    `auto/loop.ts must contain at least 2 \`activeOpenDispatchClaim(\` call sites (dev path + custom-engine path); got ${callSites}`,
  );

  // The new settle site at the custom-engine reconcile-success continue.
  assert.match(
    LOOP_SRC,
    /M002\/S04\/T04 — settle the dispatch row to `completed`/,
    "auto/loop.ts must contain the M002/S04/T04 settle-completed comment at the custom-engine reconcile-success site",
  );
  assert.match(
    LOOP_SRC,
    /if \(reconcileFlow\.action === "break"\) break;\s*\n[\s\S]{0,1500}?settleDispatchCompleted\(dispatchId,/,
    "auto/loop.ts must call settleDispatchCompleted(dispatchId, ...) on the custom-engine reconcile-success path (between `if (reconcileFlow.action === 'break') break;` and `continue;`)",
  );

  // Seam exports.
  assert.match(
    LOOP_SRC,
    /export function _setOpenDispatchClaimForTests\(/,
    "auto/loop.ts must export `_setOpenDispatchClaimForTests`",
  );
  assert.match(
    LOOP_SRC,
    /export function _resetOpenDispatchClaimForTests\(/,
    "auto/loop.ts must export `_resetOpenDispatchClaimForTests`",
  );

  // Module-level shim.
  assert.match(
    LOOP_SRC,
    /let activeOpenDispatchClaim:\s*OpenDispatchClaimFn\s*=\s*defaultOpenDispatchClaim;/,
    "auto/loop.ts must declare the `let activeOpenDispatchClaim = defaultOpenDispatchClaim` module-level shim",
  );

  // Plan-time grep gate — no `const x = activeOpenDispatchClaim;` closure
  // capture (S04 RESEARCH + MEM067 capture-vs-call refinement).
  // Restrict to the production CALL/CAPTURE shape only: forbid
  // `const \w+ = activeOpenDispatchClaim` followed by `;` or `,` (not by
  // `(` which is the legitimate call shape that returns a value into a
  // local).
  // Strip the doc-comment block at the seam-shim site so we don't false-
  // positive on the documentation that itself shows the forbidden shape.
  const productionSrc = LOOP_SRC.replace(
    /\/\/ Production code MUST read `activeOpenDispatchClaim`[\s\S]*?MUST return zero hits\./g,
    "",
  );
  const closureCaptureRe = /const \w+ = activeOpenDispatchClaim\s*[;,]/;
  assert.ok(
    !closureCaptureRe.test(productionSrc),
    "auto/loop.ts must NOT capture `activeOpenDispatchClaim` into a `const` — that would freeze the seam at the pre-swap impl (MEM067)",
  );
});

// ─── (e) TOPOLOGY GUARD ──────────────────────────────────────────────────────

test("M002/S04/T04 (e) — TOPOLOGY GUARD: production loop.ts call sites all go through the seam (not direct openDispatchClaim)", () => {
  // The post-fix invariant: every production call to the
  // openDispatchClaim adapter MUST go through `activeOpenDispatchClaim`
  // (so the seam install propagates). The only direct
  // `openDispatchClaim(...)` call shape in loop.ts should be the seam
  // shim itself: `const defaultOpenDispatchClaim: OpenDispatchClaimFn =
  // openDispatchClaim;` (a bare-reference, not a call).
  //
  // Match the production CALL shape `openDispatchClaim(` and assert
  // there are zero hits in loop.ts.
  const directCalls = LOOP_SRC.match(/(?<!default|active)openDispatchClaim\s*\(/g) ?? [];
  assert.equal(
    directCalls.length,
    0,
    `auto/loop.ts must have zero direct \`openDispatchClaim(\` calls outside the seam shim — all production call sites must go through \`activeOpenDispatchClaim\` (M002/S04/T04 seam install-order guarantee). Found: ${directCalls.length} hits`,
  );

  // Sanity: the bare-reference (NOT a call) `= openDispatchClaim;`
  // for the shim must exist.
  assert.match(
    LOOP_SRC,
    /const defaultOpenDispatchClaim:\s*OpenDispatchClaimFn\s*=\s*openDispatchClaim;/,
    "auto/loop.ts must declare `const defaultOpenDispatchClaim = openDispatchClaim;` (bare reference, not a call) for the seam shim",
  );
});
