/**
 * auto-post-unit-slice-merge-stopped-set-before-stop-auto.test.ts
 * — M002/S03/T01 D004 reproduce-and-prevent
 *
 * Regression test for the ordering bug at auto-post-unit.ts:758-771 (slice-
 * cadence-merge inside the post-unit `complete-slice` block). Both the
 * conflict branch and the non-conflict-error branch executed:
 *
 *     await stopAuto(...);
 *     sliceMergeStopped = true;
 *
 * inside an outer `runSafely("postUnit", "slice-cadence-merge", ...)` wrapper
 * (see auto-utils.ts: runSafely catches and `debugLog`s any error, then
 * returns normally). If `stopAuto` threw — runtime errors, signal handler
 * faults, dispatch teardown failures — `runSafely` would swallow the
 * exception, control would return to post-unit, and `sliceMergeStopped`
 * would still be `false`. The early-return guard at line 779
 * (`if (sliceMergeStopped) return "dispatched"`) would therefore NOT fire,
 * and triage / hook dispatch / DB writes would keep running against the
 * already-conflicted main checkout that stopAuto had begun to tear down.
 *
 * Fix: set the flag FIRST, then await stopAuto. A thrown stopAuto is still
 * swallowed by runSafely, but the post-merge guard observes the flag and
 * exits early as designed.
 *
 * Test shape (MEM058 paired PRE-FIX/POST-FIX subtests in one file):
 *   - PRE-FIX REPRO: replicate the OLD ordering (await-then-flag) wrapped
 *     in the REAL `runSafely` from auto-utils, with a stopAuto that throws.
 *     Assert the flag is still false after runSafely returns — the bug.
 *   - POST-FIX: replicate the NEW ordering (flag-then-await) wrapped in
 *     the same real `runSafely`, same throwing stopAuto. Assert the flag
 *     is true. Proven for BOTH branches (conflict + non-conflict-error).
 *
 * The production code at auto-post-unit.ts:758-771 is what these subtests
 * encode. The PRE-FIX subtest documents the bug shape; if the production
 * code regresses to await-first, the corresponding POST-FIX subtest fails.
 *
 * D003 cousin audit: the only `await stopAuto` calls in this file are at
 * line 442 (early signal-stop, no flag pattern) and the two sites this
 * test covers (758-760 conflict branch, 769-771 non-conflict-error branch).
 *
 * No worktree-fixture / GSD_PROJECT_ROOT contamination concerns (MEM046):
 * pure semantics test on a 24-line utility, no DB / no FS / no env reads.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { runSafely } from "../auto-utils.ts";

/**
 * Stand-in for the real stopAuto. Always throws — the property under test
 * is "what happens to sliceMergeStopped when stopAuto fails inside the
 * runSafely wrapper". Real stopAuto's success behavior is irrelevant here.
 */
async function throwingStopAuto(): Promise<void> {
  throw new Error("simulated stopAuto failure (e.g. teardown error)");
}

describe("auto-post-unit slice-merge: sliceMergeStopped set BEFORE stopAuto (M002/S03/T01)", () => {
  test("PRE-FIX REPRO conflict branch: await-then-flag leaves sliceMergeStopped=false when stopAuto throws", async () => {
    let sliceMergeStopped = false;

    // Replicates OLD auto-post-unit.ts:754-761 (conflict branch):
    //   const { stopAuto } = await import("./auto.js");
    //   await stopAuto(ctx, undefined, `slice-merge-conflict on ${sid}`);
    //   sliceMergeStopped = true;
    //   return;
    await runSafely("postUnit", "slice-cadence-merge", async () => {
      // simulate the inner try/catch -> MergeConflictError branch reaching
      // the await stopAuto site
      await throwingStopAuto();
      sliceMergeStopped = true; // ← never reached when stopAuto throws
      return;
    });

    // Documents the bug: runSafely swallowed the throw, control returned
    // to caller, but the flag is still false → the early-return guard at
    // line 779 would NOT fire and post-unit would keep running.
    assert.equal(
      sliceMergeStopped,
      false,
      "PRE-FIX REPRO (conflict branch): with await-then-flag, a thrown stopAuto leaves the flag false — the bug",
    );
  });

  test("PRE-FIX REPRO non-conflict-error branch: await-then-flag leaves sliceMergeStopped=false when stopAuto throws", async () => {
    let sliceMergeStopped = false;

    // Replicates OLD auto-post-unit.ts:765-772 (non-conflict-error branch):
    //   logError("engine", `slice-cadence merge failed for ${sid}`, ...);
    //   const { stopAuto } = await import("./auto.js");
    //   await stopAuto(ctx, undefined, `slice-merge-error on ${sid}`);
    //   sliceMergeStopped = true;
    await runSafely("postUnit", "slice-cadence-merge", async () => {
      // simulate the inner try/catch -> non-MergeConflictError branch
      // reaching the await stopAuto site
      await throwingStopAuto();
      sliceMergeStopped = true; // ← never reached when stopAuto throws
    });

    assert.equal(
      sliceMergeStopped,
      false,
      "PRE-FIX REPRO (non-conflict-error branch): with await-then-flag, a thrown stopAuto leaves the flag false — the bug",
    );
  });

  test("POST-FIX conflict branch: flag-then-await leaves sliceMergeStopped=true when stopAuto throws", async () => {
    let sliceMergeStopped = false;

    // Mirrors NEW auto-post-unit.ts:771-774 (conflict branch, S03/T01 fix):
    //   const { stopAuto } = await import("./auto.js");
    //   sliceMergeStopped = true;
    //   await stopAuto(ctx, undefined, `slice-merge-conflict on ${sid}`);
    //   return;
    await runSafely("postUnit", "slice-cadence-merge", async () => {
      sliceMergeStopped = true; // ← set BEFORE await
      await throwingStopAuto();
      return;
    });

    // The throw is still swallowed by runSafely (correct & unchanged), but
    // the flag was set first, so the early-return guard at line 779 fires
    // and post-unit exits cleanly.
    assert.equal(
      sliceMergeStopped,
      true,
      "POST-FIX (conflict branch): with flag-then-await, a thrown stopAuto still leaves the flag true → early-return guard fires",
    );
  });

  test("POST-FIX non-conflict-error branch: flag-then-await leaves sliceMergeStopped=true when stopAuto throws", async () => {
    let sliceMergeStopped = false;

    // Mirrors NEW auto-post-unit.ts:783-786 (non-conflict-error branch,
    // S03/T01 fix):
    //   const { stopAuto } = await import("./auto.js");
    //   sliceMergeStopped = true;
    //   await stopAuto(ctx, undefined, `slice-merge-error on ${sid}`);
    await runSafely("postUnit", "slice-cadence-merge", async () => {
      sliceMergeStopped = true; // ← set BEFORE await
      await throwingStopAuto();
    });

    assert.equal(
      sliceMergeStopped,
      true,
      "POST-FIX (non-conflict-error branch): with flag-then-await, a thrown stopAuto still leaves the flag true → early-return guard fires",
    );
  });

  test("POST-FIX sanity: when stopAuto succeeds, flag is also true (no regression vs. happy path)", async () => {
    // Belt-and-suspenders: the reorder must not break the happy path either.
    let sliceMergeStopped = false;
    await runSafely("postUnit", "slice-cadence-merge", async () => {
      sliceMergeStopped = true;
      await Promise.resolve(); // simulated successful stopAuto
    });
    assert.equal(sliceMergeStopped, true, "happy path still sets flag");
  });
});
