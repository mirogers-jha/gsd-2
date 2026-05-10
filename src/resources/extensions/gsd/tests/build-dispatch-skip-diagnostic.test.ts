// gsd-2 + Bug B2 — silent dispatch-skip observability gap.
//
// D004 reproduce-and-prevent gate.
//
// Pre-fix behavior: when `decideDispatchClaim` returned `{action:"skip"}`
// (because `recordDispatchClaim` rejected the INSERT — typically because
// another worker holds an active row, including a STALE row left by a
// crashed worker per Bug B1), the auto-mode loop did
// `finishTurn("skipped"); continue;` with NO journal event and NO UI
// notification. The user saw `iteration-start → dispatch-match → ø`
// repeating until the stuck-detector tripped with the misleading reason
// "derived 3 consecutive times without progress" — not the true root
// cause "another worker is holding the dispatch row".
//
// Post-fix: the loop emits a structured `dispatch-skip` journal event
// AND a UI warning. Both surfaces are constructed by the pure helper
// `buildDispatchSkipDiagnostic` so they can be tested in isolation
// without bringing up the entire auto-mode loop.
//
// Reproduce gate: a hand-rolled simulation of the pre-fix helper (one
// that returns an empty payload + bare message) MUST FAIL these
// assertions; the post-fix helper passes them.

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildDispatchSkipDiagnostic,
  type DispatchSkipDiagnostic,
} from "../auto/workflow-kernel.ts";

test("buildDispatchSkipDiagnostic emits structured journal payload for already-active skip", () => {
  const diag = buildDispatchSkipDiagnostic({
    unitType: "research-slice",
    unitId: "M002/S04",
    reason: "already-active",
    existingDispatchId: 42,
    existingWorker: "worker-abc-123",
  });

  // Journal payload — must include all 5 fields so post-mortem queries
  // can pinpoint the blocker WITHOUT replaying the loop.
  assert.equal(diag.journalPayload.unitType, "research-slice");
  assert.equal(diag.journalPayload.unitId, "M002/S04");
  assert.equal(diag.journalPayload.reason, "already-active");
  assert.equal(diag.journalPayload.existingDispatchId, 42);
  assert.equal(diag.journalPayload.existingWorker, "worker-abc-123");
});

test("buildDispatchSkipDiagnostic UI message names the unit, reason, AND blocking worker for already-active", () => {
  const diag = buildDispatchSkipDiagnostic({
    unitType: "research-slice",
    unitId: "M002/S04",
    reason: "already-active",
    existingDispatchId: 42,
    existingWorker: "worker-abc-123",
  });

  // Must mention what was skipped + why.
  assert.match(diag.message, /research-slice M002\/S04/);
  assert.match(diag.message, /already-active/);
  // Must mention the blocking worker so the user can pin down the cause
  // (e.g. "ah, that's the worker that crashed").
  assert.match(diag.message, /worker-abc-123/);
  // Must mention the existing dispatch row id so /gsd doctor or manual
  // SQL can target the exact row.
  assert.match(diag.message, /42/);
  // Must surface the actionable next-step (run /gsd doctor) — without
  // this hint the user has to grep code to figure out what to do.
  assert.match(diag.message, /\/gsd doctor/);
});

test("buildDispatchSkipDiagnostic UI message handles stale-lease distinctly", () => {
  const diag = buildDispatchSkipDiagnostic({
    unitType: "execute-task",
    unitId: "M001/S01/T01",
    reason: "stale-lease",
  });

  assert.match(diag.message, /stale-lease/);
  // stale-lease has a different remediation than already-active.
  assert.match(diag.message, /lease/);
  assert.match(diag.message, /\/gsd auto/);
  // Must NOT include already-active boilerplate.
  assert.doesNotMatch(diag.message, /Active worker/);
});

test("buildDispatchSkipDiagnostic omits existingDispatchId/existingWorker from payload when absent", () => {
  // stale-lease does not carry existing-dispatch info.
  const diag = buildDispatchSkipDiagnostic({
    unitType: "execute-task",
    unitId: "M001/S01/T01",
    reason: "stale-lease",
  });

  assert.equal(diag.journalPayload.unitType, "execute-task");
  assert.equal(diag.journalPayload.unitId, "M001/S01/T01");
  assert.equal(diag.journalPayload.reason, "stale-lease");
  assert.equal(
    "existingDispatchId" in diag.journalPayload,
    false,
    "existingDispatchId must be omitted (not undefined) so journal post-mortem queries don't see noise",
  );
  assert.equal(
    "existingWorker" in diag.journalPayload,
    false,
    "existingWorker must be omitted (not undefined)",
  );
});

test("buildDispatchSkipDiagnostic omits existingWorker when only dispatchId is known", () => {
  // Edge case: claim returns existingId but no worker (unknown owner).
  const diag = buildDispatchSkipDiagnostic({
    unitType: "plan-slice",
    unitId: "M002/S04",
    reason: "already-active",
    existingDispatchId: 99,
  });

  assert.equal(diag.journalPayload.existingDispatchId, 99);
  assert.equal("existingWorker" in diag.journalPayload, false);
  // Message should still include the dispatch id even without worker.
  assert.match(diag.message, /99/);
  assert.doesNotMatch(diag.message, /Active worker:/);
});

test("buildDispatchSkipDiagnostic falls back gracefully for unknown reason strings", () => {
  // Defensive: future reason codes shouldn't crash the helper.
  const diag = buildDispatchSkipDiagnostic({
    unitType: "plan-slice",
    unitId: "M001/S01",
    reason: "future-reason-not-yet-coded",
  });

  // Bare message + structured payload, no extra hint.
  assert.match(diag.message, /plan-slice M001\/S01/);
  assert.match(diag.message, /future-reason-not-yet-coded/);
  assert.equal(diag.journalPayload.reason, "future-reason-not-yet-coded");
});

test("D004 — silent-pre-fix simulation FAILS the diagnostic contract", () => {
  // Hand-rolled pre-fix helper that returns an empty payload + bare
  // message. This simulates the original `loop.ts:723` behavior of
  // emitting nothing observable.
  const prefixSimulation = (input: {
    unitType: string;
    unitId: string;
    reason: string;
  }): DispatchSkipDiagnostic => ({
    message: "",
    journalPayload: {},
  });

  const diag = prefixSimulation({
    unitType: "research-slice",
    unitId: "M002/S04",
    reason: "already-active",
  });

  // Pre-fix message has no unit info, no reason, no actionable hint —
  // exactly the M002/S04 forensics symptom (zero diagnostic surface).
  assert.equal(diag.message, "");
  assert.equal(Object.keys(diag.journalPayload).length, 0);

  // The post-fix helper REPAIRS this contract:
  const fixed = buildDispatchSkipDiagnostic({
    unitType: "research-slice",
    unitId: "M002/S04",
    reason: "already-active",
    existingDispatchId: 42,
    existingWorker: "worker-abc-123",
  });
  assert.notEqual(fixed.message, "");
  assert.ok(Object.keys(fixed.journalPayload).length >= 3);
});
