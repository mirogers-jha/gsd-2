/**
 * auto-artifact-paths-rejects-dotdot-traversal.test.ts
 *
 * D004 reproduce-and-prevent for M002/S02/T01.
 *
 * Bug (HIGH-severity): `auto-artifact-paths.ts:resolveExpectedArtifactPath`
 * and `diagnoseExpectedArtifact` switch over `unitType` and feed
 * operator-controlled `mid`/`sid`/`tid` (out of `parseUnitId`, which does
 * zero validation) into path-joining helpers. Operator/queue-controlled IDs
 * containing `..`, NUL, empty, or non-string values reach disk-resolution
 * helpers — path traversal surface.
 *
 * Fix (T01): direct-import `assertMilestoneId`/`assertSliceId`/`assertTaskId`
 * from `milestone-ids.ts` and assert at every path-joining case-arm BEFORE
 * any path helper runs. Sentinel `parallel-research` in the `research-slice`
 * arm runs BEFORE `assertSliceId(sid!)` so legitimate fan-out keeps working.
 *
 * RED proof (pre-fix, manual revert): comment out the `assertMilestoneId`/
 * `assertSliceId`/`assertTaskId` calls in both functions — the 6 traversal
 * subtests fail (no throw) while sentinel + happy-path still pass.
 * GREEN proof (post-fix): all 8 subtests pass.
 *
 * Direct-import (no barrel) per MEM009 — `instanceof InvalidIdError` would
 * silently fail across module-resolution boundaries otherwise.
 *
 * Worktree-env caveat (MEM032/MEM035): this test does NOT use a tmp-dir
 * worktree fixture — it only exercises pure validator throws against a
 * caller-supplied `base` string, so `GSD_PROJECT_ROOT` short-circuiting in
 * `resolveWorktreeProjectRoot()` cannot contaminate it. Documented here so
 * future debuggers don't conflate this test's lack of `env -u
 * GSD_PROJECT_ROOT` prefix with the worktree-fixture tests that genuinely
 * need it.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  resolveExpectedArtifactPath,
  diagnoseExpectedArtifact,
} from "../auto-artifact-paths.ts";
import { InvalidIdError } from "../milestone-ids.ts";

// Arbitrary `base` — the validators throw before any FS access, so the path
// only needs to exist as a string. Keeping it constant across subtests proves
// the throws are id-driven, not path-driven.
const BASE = "/tmp/auto-artifact-paths-test-base";

describe("auto-artifact-paths: rejects path-traversal IDs", () => {
  test("mid='..' on milestone arm throws InvalidIdError(kind=milestone)", () => {
    assert.throws(
      () => resolveExpectedArtifactPath("discuss-milestone", "..", BASE),
      (err: unknown) =>
        err instanceof InvalidIdError &&
        err.kind === "milestone" &&
        err.attemptedId === "..",
    );
    assert.throws(
      () => diagnoseExpectedArtifact("discuss-milestone", "..", BASE),
      (err: unknown) =>
        err instanceof InvalidIdError && err.kind === "milestone",
    );
  });

  test("sid='..' on slice arm throws InvalidIdError(kind=slice)", () => {
    assert.throws(
      () => resolveExpectedArtifactPath("plan-slice", "M001/..", BASE),
      (err: unknown) =>
        err instanceof InvalidIdError &&
        err.kind === "slice" &&
        err.attemptedId === "..",
    );
    assert.throws(
      () => diagnoseExpectedArtifact("plan-slice", "M001/..", BASE),
      (err: unknown) =>
        err instanceof InvalidIdError && err.kind === "slice",
    );
  });

  test("sid='Sxx..' fails the anchored ^S\\d{2}$ regex", () => {
    // parseUnitId splits on '/', so we craft a unitId where the slice
    // segment literally contains traversal chars without a separator.
    assert.throws(
      () => resolveExpectedArtifactPath("plan-slice", "M001/Sxx..", BASE),
      (err: unknown) =>
        err instanceof InvalidIdError && err.kind === "slice",
    );
  });

  test("tid='T01\\x00' throws InvalidIdError(kind=task) — NUL blocked by regex", () => {
    assert.throws(
      () => resolveExpectedArtifactPath("execute-task", "M001/S01/T01\x00", BASE),
      (err: unknown) =>
        err instanceof InvalidIdError && err.kind === "task",
    );
    assert.throws(
      () => diagnoseExpectedArtifact("execute-task", "M001/S01/T01\x00", BASE),
      (err: unknown) =>
        err instanceof InvalidIdError && err.kind === "task",
    );
  });

  test("mid='' throws InvalidIdError — typeof+regex catches empty string", () => {
    assert.throws(
      () => resolveExpectedArtifactPath("discuss-milestone", "", BASE),
      (err: unknown) =>
        err instanceof InvalidIdError && err.kind === "milestone",
    );
  });

  test("mid=null on milestone arm throws InvalidIdError (typeof check)", () => {
    // Use `null as unknown as string` to bypass TS while exercising the
    // typeof !== 'string' short-circuit in assertMilestoneId.
    const unitId = null as unknown as string;
    assert.throws(
      () => resolveExpectedArtifactPath("complete-milestone", unitId, BASE),
      (err: unknown) =>
        err instanceof InvalidIdError && err.kind === "milestone",
    );
  });

  test("research-slice + sid='parallel-research' returns milestone PARALLEL-BLOCKER path (sentinel preserved)", () => {
    // Sentinel branch must run BEFORE assertSliceId. If a future refactor
    // moves assertSliceId above the sentinel check, this throws.
    const result = resolveExpectedArtifactPath(
      "research-slice",
      "M001/parallel-research",
      BASE,
    );
    assert.ok(
      result === null || result.includes("PARALLEL-BLOCKER"),
      `expected PARALLEL-BLOCKER path or null (no on-disk milestone), got: ${result}`,
    );

    const diag = diagnoseExpectedArtifact(
      "research-slice",
      "M001/parallel-research",
      BASE,
    );
    assert.ok(
      diag === null || diag.includes("PARALLEL-BLOCKER"),
      `expected PARALLEL-BLOCKER diagnostic or null, got: ${diag}`,
    );
  });

  test("execute-task + 'M001/S01/T01' resolves without throwing (happy path)", () => {
    assert.doesNotThrow(() => {
      const result = resolveExpectedArtifactPath(
        "execute-task",
        "M001/S01/T01",
        BASE,
      );
      // Either a resolved tasks/T01-SUMMARY.md path or null when the on-disk
      // slice dir doesn't exist — both are non-throwing happy-path outcomes.
      assert.ok(result === null || result.includes("T01-SUMMARY"));
    });
    assert.doesNotThrow(() => {
      const diag = diagnoseExpectedArtifact(
        "execute-task",
        "M001/S01/T01",
        BASE,
      );
      assert.ok(diag === null || diag.includes("T01"));
    });
  });
});
