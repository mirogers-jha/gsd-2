/**
 * auto-worktree-restores-shelter-on-throw-unit.test.ts
 * — M002/S03/T03 D004 reproduce-and-prevent (HARDENING per D011/MEM044)
 *
 * D011 plan-time investigation outcome [NOT REPRODUCED M002/S03 — hardening
 * shipped]: the originally-claimed leak path
 * (`auto-worktree.ts:2167-2186` throw skips `restoreShelter()` and stash-pop)
 * is BENIGN in current code. At the prior 9a-iii call site,
 * `restoreShelter()` runs UNCONDITIONALLY before the safety throw at the
 * 9b/9b-ii check, and the stash-pop block at 9a-ii also runs before the
 * throw. Both shelter and stash are already restored when the safety check
 * throws today.
 *
 * Per D011/MEM044 we still ship the fix (a `try/finally` envelope around
 * the 9-step squash-merge block) as **defense-in-depth** against any
 * FUTURE throw added between the last existing cleanup and the end of
 * teardown. Both this unit test and the sibling behavioral test
 * (`auto-worktree-restores-shelter-on-throw.test.ts`) are classified as
 * HARDENING in the T05 bug-list annotation.
 *
 * Test shape (MEM058 paired PRE-FIX/POST-FIX subtests in one file):
 *   - PRE-FIX REPRO: replicate the bare squash-merge block shape (no
 *     enclosing try/finally) with synthetic-throw stub for the safety
 *     check. Assert that cleanup spies are NOT invoked when the throw
 *     escapes — encodes the failure mode the envelope is designed to
 *     prevent.
 *   - POST-FIX: replicate the envelope shape (try/finally + already-run
 *     guards). Same synthetic throw. Assert that cleanup spies ARE
 *     invoked exactly once each (envelope branch reached, not happy
 *     path).
 *   - ALREADY-RAN GUARD POST-FIX: encode that when the existing happy-path
 *     cleanup already ran (flags set), the envelope's finally is a
 *     documented no-op (no double-pop, no double-restore).
 *   - ENVELOPE THROWS DO NOT MASK ORIGINAL: envelope finally that itself
 *     throws does not swallow the original error — the original throw
 *     still propagates per the project-default policy of "log warnings
 *     in finally, never re-throw".
 *   - PRODUCTION SOURCE GUARD: `readFileSync` of `auto-worktree.ts`
 *     confirms the envelope marker comments and the new logWarning paths
 *     ship in production. Encodes the "fix is present" contract; if a
 *     future refactor silently removes the envelope, this guard fires.
 *
 * Inline-replicated subtests use thin local stand-ins so the bug shape +
 * fix shape are durably encoded without needing to revert and re-compile
 * the production source.
 *
 * No worktree-fixture / GSD_PROJECT_ROOT contamination concerns (MEM046):
 * pure semantics test on the envelope-shape logic, no DB / no FS / no env
 * reads beyond the production-source string-grep.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

interface Spy {
  count: number;
}

function makeSpy(): Spy {
  return { count: 0 };
}

/**
 * PRE-FIX shape: bare squash-merge block (no enclosing try/finally).
 * If the synthetic safety-check throws, cleanup spies are never invoked —
 * encodes the failure mode the envelope is designed to prevent.
 *
 * Mirrors the production code shape AS IF the existing happy-path
 * `restoreShelter()` (9a-iii) and `popStashByRef` (9a-ii) had not yet run
 * at the throw point — i.e. the future-regression scenario per D011.
 */
function preFixSquashMergeBlock(opts: {
  shelterSpy: Spy;
  stashSpy: Spy;
  throwInSafetyCheck: () => never;
}): void {
  // ... step 8/9/9a/9a-ii/9a-iii would normally run here ...
  // simulate a regression where one of those cleanups was DEFERRED past
  // the safety check (the future-regression scenario).
  opts.throwInSafetyCheck();
  // these cleanup calls would run AFTER the safety check in this
  // hypothetical future-regression layout, and are NEVER reached on throw
  // in the bare (no-envelope) shape.
  opts.shelterSpy.count++;
  opts.stashSpy.count++;
}

/**
 * POST-FIX shape: try/finally envelope with already-run guards. Mirrors
 * the production code shape at `auto-worktree.ts:~1965-2255`.
 *
 * `stashPopped` and `shelterRestored` are local already-run flags that
 * skip the finally branch when the happy path has already run cleanup.
 */
function postFixSquashMergeBlock(opts: {
  shelterSpy: Spy;
  stashSpy: Spy;
  stashPoppedAlready: boolean;
  shelterRestoredAlready: boolean;
  throwInSafetyCheck: () => never;
  finallyShelterFn?: () => void;
  finallyStashFn?: () => void;
}): void {
  let stashPopped = opts.stashPoppedAlready;
  let shelterRestored = opts.shelterRestoredAlready;
  try {
    opts.throwInSafetyCheck();
    // would normally fall through to step 9c here...
    // mark cleanup already-ran on happy path (production has these set
    // by the existing 9a-ii / 9a-iii call sites that ran above).
    stashPopped = true;
    shelterRestored = true;
  } finally {
    if (!stashPopped) {
      try {
        (opts.finallyStashFn ?? (() => {}))();
        opts.stashSpy.count++;
      } catch {
        /* swallowed — production logs a warning, never re-throws */
      }
    }
    if (!shelterRestored) {
      try {
        (opts.finallyShelterFn ?? (() => {}))();
        opts.shelterSpy.count++;
      } catch {
        /* swallowed — production logs a warning, never re-throws */
      }
    }
  }
}

describe("auto-worktree squash-merge try/finally envelope (M002/S03/T03 — D011/MEM044 hardening)", () => {
  test("PRE-FIX REPRO — bare block: synthetic safety-check throw bypasses cleanup spies (the regression shape the envelope is designed to prevent)", () => {
    const shelterSpy = makeSpy();
    const stashSpy = makeSpy();
    let caught: unknown = null;
    try {
      preFixSquashMergeBlock({
        shelterSpy,
        stashSpy,
        throwInSafetyCheck: () => {
          throw new Error("synthetic safety-check throw");
        },
      });
    } catch (e) {
      caught = e;
    }
    assert.ok(caught instanceof Error, "throw propagated");
    assert.equal(
      shelterSpy.count,
      0,
      "PRE-FIX bare block: shelter cleanup NEVER ran — this is the future-regression failure mode",
    );
    assert.equal(
      stashSpy.count,
      0,
      "PRE-FIX bare block: stash cleanup NEVER ran — this is the future-regression failure mode",
    );
  });

  test("POST-FIX — envelope branch: synthetic safety-check throw runs both cleanup spies exactly once (defense-in-depth)", () => {
    const shelterSpy = makeSpy();
    const stashSpy = makeSpy();
    let caught: unknown = null;
    try {
      postFixSquashMergeBlock({
        shelterSpy,
        stashSpy,
        stashPoppedAlready: false, // simulate the future-regression
        shelterRestoredAlready: false, // window: cleanup HASN'T run yet
        throwInSafetyCheck: () => {
          throw new Error("synthetic safety-check throw");
        },
      });
    } catch (e) {
      caught = e;
    }
    assert.ok(caught instanceof Error, "original throw propagated");
    assert.equal(shelterSpy.count, 1, "envelope finally restored shelter exactly once");
    assert.equal(stashSpy.count, 1, "envelope finally popped stash exactly once");
  });

  test("POST-FIX — already-ran guards: when happy-path cleanup already ran (flags set), envelope finally is a no-op (no double cleanup)", () => {
    const shelterSpy = makeSpy();
    const stashSpy = makeSpy();
    let caught: unknown = null;
    try {
      postFixSquashMergeBlock({
        shelterSpy,
        stashSpy,
        stashPoppedAlready: true, // production happy path: 9a-ii ran
        shelterRestoredAlready: true, // production happy path: 9a-iii ran
        throwInSafetyCheck: () => {
          throw new Error("synthetic safety-check throw");
        },
      });
    } catch (e) {
      caught = e;
    }
    assert.ok(caught instanceof Error, "original throw still propagated");
    assert.equal(
      shelterSpy.count,
      0,
      "envelope finally did NOT double-restore shelter (already-ran guard active)",
    );
    assert.equal(
      stashSpy.count,
      0,
      "envelope finally did NOT double-pop stash (already-ran guard active)",
    );
  });

  test("POST-FIX — finally throws do not mask the original error (warnings logged, never re-thrown)", () => {
    const shelterSpy = makeSpy();
    const stashSpy = makeSpy();
    const originalErr = new Error("synthetic safety-check throw");
    let caught: unknown = null;
    try {
      postFixSquashMergeBlock({
        shelterSpy,
        stashSpy,
        stashPoppedAlready: false,
        shelterRestoredAlready: false,
        throwInSafetyCheck: () => {
          throw originalErr;
        },
        // Both finally cleanups themselves throw — production swallows
        // these inside try/catch + logWarning, never re-throws.
        finallyShelterFn: () => {
          throw new Error("shelter restore failed: ENOENT");
        },
        finallyStashFn: () => {
          throw new Error("stash pop failed: not on a branch");
        },
      });
    } catch (e) {
      caught = e;
    }
    assert.equal(
      caught,
      originalErr,
      "the ORIGINAL safety-check throw propagates (finally throws are swallowed and logged)",
    );
    // Spies were NOT incremented because the finally callbacks threw before
    // bumping the counter — proves the swallow path was exercised.
    assert.equal(
      shelterSpy.count,
      0,
      "shelter spy NOT incremented (finally callback threw, swallowed by inner try/catch)",
    );
    assert.equal(
      stashSpy.count,
      0,
      "stash spy NOT incremented (finally callback threw, swallowed by inner try/catch)",
    );
  });

  test("PRODUCTION SOURCE GUARD — auto-worktree.ts contains the M002/S03/T03 try/finally envelope and the new logWarning paths", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    // dist-test layout: dist-test/src/resources/extensions/gsd/tests/this-file.js
    // Source file:      src/resources/extensions/gsd/auto-worktree.ts
    const candidates = [
      join(here, "..", "auto-worktree.ts"),
      join(here, "..", "auto-worktree.js"),
      join(
        here,
        "..",
        "..",
        "..",
        "..",
        "..",
        "..",
        "src",
        "resources",
        "extensions",
        "gsd",
        "auto-worktree.ts",
      ),
    ];
    let source: string | null = null;
    for (const candidate of candidates) {
      try {
        source = readFileSync(candidate, "utf8");
        break;
      } catch {
        continue;
      }
    }
    assert.ok(source !== null, "auto-worktree source file resolvable from test");
    assert.match(
      source!,
      /M002\/S03\/T03 — Defense-in-depth try\/finally envelope/,
      "envelope marker comment present (M002/S03/T03 hardening)",
    );
    assert.match(
      source!,
      /finally cleanup: stash pop failed:/,
      "envelope finally logs `stash pop failed` warning",
    );
    assert.match(
      source!,
      /finally cleanup: restoreShelter failed:/,
      "envelope finally logs `restoreShelter failed` warning",
    );
    assert.match(
      source!,
      /let stashPopped = false;/,
      "stash already-ran guard flag declared",
    );
    assert.match(
      source!,
      /D011\/MEM044 hardening/,
      "D011/MEM044 hardening classification documented in source",
    );
  });
});
