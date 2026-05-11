/**
 * auto-model-selection-rejects-unknown-tier.test.ts
 * — M002/S05/T02 D004 + smoke test for the unknown previousTier
 *   fall-through fix in auto-model-selection.ts.
 *
 * D011 verdict (S05-CONTEXT): REPRODUCES — pre-fix the silent `?? 0`
 * fall-through coerced any unknown previousTier (typo, experimental
 * tier, version skew) to 0 = "light" via `tierOrder[unknownTier] ?? 0`,
 * which combined with a fresh classification of "light" produced no
 * escalation/retention — the retry silently ran against the lowest-tier
 * model with zero observability.
 *
 * Bug shape
 *   Pre-fix code shape (auto-model-selection.ts:373-378):
 *     const tierOrder: Record<string, number> = { light: 0, standard: 1, heavy: 2 };
 *     const prevOrder = tierOrder[retryContext.previousTier] ?? 0;  // ← silent
 *     const freshOrder = tierOrder[classification.tier] ?? 0;
 *     if (prevOrder > freshOrder) {
 *       classification = { ...classification, tier: retryContext.previousTier as ComplexityTier, ... };
 *     }
 *
 *   Result: previousTier="experimental" → prevOrder=0 (light) → if fresh
 *   tier is "light", prevOrder !> freshOrder → no retain → retry uses
 *   classification.tier as-is (the lowest tier when classification is
 *   light). Silent downgrade.
 *
 *   Post-fix code shape:
 *     const tierOrder: Record<string, number> = { light: 0, standard: 1, heavy: 2 };
 *     if (!(retryContext.previousTier in tierOrder)) {
 *       logWarning("dispatch", `unknown previousTier '${...}'; escalating to standard ...`);
 *       classification = { ...classification, tier: "standard" as ComplexityTier, reason: "unknown previousTier escalated to standard" };
 *     } else {
 *       const prevOrder = tierOrder[retryContext.previousTier] ?? 0;
 *       const freshOrder = tierOrder[classification.tier] ?? 0;
 *       if (prevOrder > freshOrder) { ... }
 *     }
 *
 *   Unknown previousTier now → explicit warn log + force "standard"
 *   (graceful escalation, observable, no silent downgrade).
 *
 * Test shape (MEM058 paired-subtest D004 + MEM060 source guard, mirrors
 * M002/S04/S05 prior tests)
 *   (a) PRE-FIX REPRO subtest     — replicate the buggy `?? 0` shape inline,
 *                                   pass an unknown previousTier, assert
 *                                   the resulting tier is "light" (silent
 *                                   downgrade).
 *   (b) POST-FIX subtest          — replicate the explicit-guard shape
 *                                   inline, pass the same unknown
 *                                   previousTier, assert the resulting
 *                                   tier is "standard" AND the warn log
 *                                   fired in `peekLogs("dispatch")`.
 *   (c) PRODUCTION SOURCE GUARD   — string-grep auto-model-selection.ts
 *                                   for: the M002/S05/T02 marker comment,
 *                                   the explicit `if (!(retryContext.previousTier
 *                                   in tierOrder))` guard, the
 *                                   logWarning("dispatch", ...) emission,
 *                                   the "standard" escalation.
 *
 * R015 compliance: no new dependencies. node:test + node:fs only.
 *
 * MEM046 baseline: prefix CI runs with
 *   `env -u GSD_PROJECT_ROOT PATH="$PWD/node_modules/.bin:$PATH"`
 * to avoid worktree-resolver contamination.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { peekLogs, _resetLogs, logWarning } from "../workflow-logger.ts";

const MODEL_SELECTION_SRC = (() => {
  const here = new URL(import.meta.url);
  const path = here.pathname;
  const idx = path.indexOf("/dist-test/");
  const repoRoot = idx !== -1 ? path.slice(0, idx) : process.cwd();
  return readFileSync(
    join(repoRoot, "src/resources/extensions/gsd/auto-model-selection.ts"),
    "utf-8",
  );
})();

type Tier = "light" | "standard" | "heavy";
type Classification = { tier: Tier; reason: string };

// ─── (a) PRE-FIX REPRO ───────────────────────────────────────────────────────

test("M002/S05/T02 (a) — PRE-FIX REPRO: unknown previousTier silently coerces to 'light' via `?? 0` fall-through, leaving the retry at the lowest tier", () => {
  // Replicate the PRE-FIX code shape inline.
  const tierOrder: Record<string, number> = { light: 0, standard: 1, heavy: 2 };
  let classification: Classification = { tier: "light", reason: "fresh classification" };
  const previousTier = "experimental"; // unknown — typo / version-skew

  // PRE-FIX SHAPE
  const prevOrder = tierOrder[previousTier] ?? 0;
  const freshOrder = tierOrder[classification.tier] ?? 0;
  if (prevOrder > freshOrder) {
    classification = { ...classification, tier: previousTier as Tier, reason: "retained escalated tier from retry" };
  }

  // PRE-FIX BUG: tier is still "light" even though previousTier was unknown —
  // the silent `?? 0` swallowed the unknown signal.
  assert.equal(
    classification.tier,
    "light",
    "pre-fix shape: unknown previousTier silently produces 'light' tier (the BUG — no observability, no escalation)",
  );
  assert.equal(prevOrder, 0, "pre-fix: unknown tier coerces to 0 (= light) via `?? 0`");
});

// ─── (b) POST-FIX ────────────────────────────────────────────────────────────

test("M002/S05/T02 (b) — POST-FIX: unknown previousTier triggers explicit guard → logWarning('dispatch') + escalate to 'standard'", () => {
  _resetLogs();

  // Replicate the POST-FIX explicit-guard shape inline.
  const tierOrder: Record<string, number> = { light: 0, standard: 1, heavy: 2 };
  let classification: Classification = { tier: "light", reason: "fresh classification" };
  const previousTier = "experimental"; // unknown — same as PRE-FIX subtest

  // POST-FIX SHAPE
  if (!(previousTier in tierOrder)) {
    logWarning(
      "dispatch",
      `unknown previousTier '${previousTier}'; escalating to standard for retry safety (M002/S05/T02)`,
      { previousTier: String(previousTier), unitType: "execute-task", unitId: "M001/S01/T01" },
    );
    classification = { ...classification, tier: "standard" as Tier, reason: "unknown previousTier escalated to standard" };
  } else {
    const prevOrder = tierOrder[previousTier] ?? 0;
    const freshOrder = tierOrder[classification.tier] ?? 0;
    if (prevOrder > freshOrder) {
      classification = { ...classification, tier: previousTier as Tier, reason: "retained escalated tier from retry" };
    }
  }

  // POST-FIX: tier escalated to "standard" (graceful + observable).
  assert.equal(
    classification.tier,
    "standard",
    "post-fix: unknown previousTier escalates to 'standard' (graceful degradation, never silently downgrades to light)",
  );
  assert.equal(
    classification.reason,
    "unknown previousTier escalated to standard",
    "post-fix: classification.reason carries the escalation rationale for downstream observers",
  );

  // Observability assertion — warn log fired with the expected component
  // and message shape.
  const logs = peekLogs();
  const matchingLogs = logs.filter(
    (l) => l.component === "dispatch" && typeof l.message === "string" && l.message.includes("unknown previousTier"),
  );
  assert.ok(
    matchingLogs.length >= 1,
    `expected at least one logWarning('dispatch', 'unknown previousTier ...') entry; got ${logs.length} log entries total`,
  );
  assert.equal(matchingLogs[0]!.severity, "warn");
  assert.match(matchingLogs[0]!.message, /escalating to standard/);

  _resetLogs();
});

// ─── (c) PRODUCTION SOURCE GUARD ─────────────────────────────────────────────

test("M002/S05/T02 (c) — PRODUCTION SOURCE GUARD: auto-model-selection.ts contains the explicit unknown-tier guard + logWarning + 'standard' escalation", () => {
  // M002/S05/T02 marker comment.
  assert.match(
    MODEL_SELECTION_SRC,
    /M002\/S05\/T02 — explicit unknown-tier guard/,
    "auto-model-selection.ts must contain the M002/S05/T02 marker comment near the unknown-tier guard",
  );

  // Explicit guard.
  assert.match(
    MODEL_SELECTION_SRC,
    /if \(!\(retryContext\.previousTier in tierOrder\)\)\s*\{/,
    "auto-model-selection.ts must contain the explicit `if (!(retryContext.previousTier in tierOrder))` guard",
  );

  // logWarning('dispatch', ...) emission.
  assert.match(
    MODEL_SELECTION_SRC,
    /logWarning\(\s*"dispatch",\s*`unknown previousTier '\$\{retryContext\.previousTier\}'/,
    "auto-model-selection.ts must call logWarning('dispatch', `unknown previousTier '${retryContext.previousTier}'; ...`)",
  );

  // Escalate to "standard" (NOT "light").
  assert.match(
    MODEL_SELECTION_SRC,
    /tier:\s*"standard"\s+as\s+ComplexityTier,\s*reason:\s*"unknown previousTier escalated to standard"/,
    "auto-model-selection.ts must escalate to `tier: 'standard' as ComplexityTier` with reason 'unknown previousTier escalated to standard' (graceful degradation, never silently downgrades to light)",
  );

  // Negative guard — the existing #4973 retain-escalated-tier branch
  // (now inside the else-clause of the new guard) MUST still exist.
  assert.match(
    MODEL_SELECTION_SRC,
    /reason:\s*"retained escalated tier from retry"/,
    "auto-model-selection.ts must preserve the existing #4973 retain-escalated-tier branch (now inside the new else-clause)",
  );
});
