/**
 * auto-worktree-rejects-gsd-only-commit-when-no-native-commit.test.ts
 * — M002/S03/T02 D004 reproduce-and-prevent
 *
 * Regression test for the `.gsd/`-only silent-data-loss bug at
 * auto-worktree.ts:2074-2076 (bug-list line 31). When `nativeCommit` returns
 * `null` ("nothing to commit") and the milestone branch differs from the
 * integration branch by ONLY `.gsd/`-prefixed files (libgit2 hiccup,
 * unicode-only diff git CLI cannot see, or genuine metadata-only milestone),
 * the existing 9b safety check at lines 2167-2186 — which filters numstat
 * for non-`.gsd/` paths — would let teardown proceed and the milestone's
 * `.gsd/` work was silently destroyed.
 *
 * Fix: a SIBLING safety branch (`9b-ii`) immediately after the existing 9b
 * check filters numstat for `.gsd/`-prefixed paths and throws GSDError with
 * an operator-facing message (count + first 3 sample paths + 3-step
 * remediation) BEFORE teardown. `process.chdir(previousCwd)` runs FIRST so
 * the operator is not stranded on the integration branch (#2929 contract).
 *
 * Test shape (MEM058 paired PRE-FIX/POST-FIX subtests in one file):
 *   - PRE-FIX REPRO: replicate the OLD filter — `non-.gsd/ entries only`.
 *     Feed a numstat that contains ONLY `.gsd/` paths.  Assert NO throw —
 *     this is the bug shape (silent-data-loss path is reached).
 *   - POST-FIX: replicate the NEW filter — `.gsd/ entries only` — alongside
 *     the OLD non-`.gsd/` filter, mirroring the production code at
 *     auto-worktree.ts:2167-2189.  Same numstat input.  Assert GSDError
 *     thrown with code === GSD_GIT_ERROR and message contains the file
 *     count, the first 3 sample paths, and the 3-step remediation marker.
 *   - REGRESSION GUARD: numstat returns ONLY non-`.gsd/` entries — the
 *     EXISTING 9b throw still fires. Encodes that the new sibling check is
 *     additive, not destructive.
 *   - SAMPLE TRUNCATION: numstat returns 5 `.gsd/` entries — assert the
 *     thrown message lists the first 3 followed by `, …` and reports
 *     count `5`.
 *   - NO `.gsd/` AND NO CODE: numstat empty — neither check fires (safe
 *     teardown path preserved).
 *
 * The production code at auto-worktree.ts:2167-2189 is what these subtests
 * encode. The PRE-FIX subtest documents the bug shape; if the production
 * code regresses to "filter non-.gsd/ only", the corresponding POST-FIX
 * subtest still passes (it tests the production filter logic in isolation),
 * so the test additionally asserts that the production source contains the
 * 9b-ii sibling block by string-grepping the file. This guards against a
 * future refactor that silently removes the new check.
 *
 * D003 cousin audit: only one `nativeCommit(originalBasePath_, …)` site in
 * `mergeMilestoneToMain` (line 2074) — the other `nativeCommit` call at
 * line 1551 is `autoCommitDirtyState` and runs BEFORE the worktree-merge
 * teardown sequence (different control-flow window).  No same-file cousins
 * in scope.
 *
 * No worktree-fixture / GSD_PROJECT_ROOT contamination concerns (MEM046):
 * pure semantics test on the filter+throw logic, no DB / no FS / no env
 * reads beyond the production-source string-grep.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { GSDError, GSD_GIT_ERROR } from "../errors.ts";

interface Numstat {
  added: number;
  removed: number;
  path: string;
}

const MILESTONE_BRANCH = "milestone/M002";
const MAIN_BRANCH = "main";

/**
 * PRE-FIX shape: non-.gsd/ filter ONLY (no sibling .gsd/ branch). Mirrors
 * auto-worktree.ts before the M002/S03/T02 fix — feeding a `.gsd/`-only
 * numstat results in ZERO throws (the silent-data-loss bug).
 */
function preFixNothingToCommitGuard(numstat: Numstat[]): void {
  const codeChanges = numstat.filter((entry) => !entry.path.startsWith(".gsd/"));
  if (codeChanges.length > 0) {
    throw new GSDError(
      GSD_GIT_ERROR,
      `Squash merge produced nothing to commit but milestone branch "${MILESTONE_BRANCH}" ` +
        `has ${codeChanges.length} code file(s) not on "${MAIN_BRANCH}". ` +
        `Aborting worktree teardown to prevent data loss.`,
    );
  }
  // No sibling .gsd/ branch — the bug shape.
}

/**
 * POST-FIX shape: BOTH the existing non-.gsd/ filter AND the new sibling
 * .gsd/-only filter. Direct copy of the production logic at
 * auto-worktree.ts:2167-2189 (without the chdir, which is an FS side
 * effect — exercised by the behavioral test).
 */
function postFixNothingToCommitGuard(numstat: Numstat[]): void {
  const codeChanges = numstat.filter((entry) => !entry.path.startsWith(".gsd/"));
  if (codeChanges.length > 0) {
    throw new GSDError(
      GSD_GIT_ERROR,
      `Squash merge produced nothing to commit but milestone branch "${MILESTONE_BRANCH}" ` +
        `has ${codeChanges.length} code file(s) not on "${MAIN_BRANCH}". ` +
        `Aborting worktree teardown to prevent data loss.`,
    );
  }

  const gsdChanges = numstat.filter((entry) => entry.path.startsWith(".gsd/"));
  if (gsdChanges.length > 0) {
    const samplePaths = gsdChanges.slice(0, 3).map((e) => e.path);
    const moreSuffix = gsdChanges.length > 3 ? ", …" : "";
    const sample = samplePaths.join(", ") + moreSuffix;
    throw new GSDError(
      GSD_GIT_ERROR,
      `Squash merge produced nothing to commit but milestone branch "${MILESTONE_BRANCH}" ` +
        `has ${gsdChanges.length} .gsd/ file(s) not on "${MAIN_BRANCH}" (${sample}). ` +
        `Aborting worktree teardown to prevent data loss. ` +
        `Remediation: (1) inspect milestoneBranch with \`git diff ${MAIN_BRANCH}...${MILESTONE_BRANCH} -- .gsd/\`; ` +
        `(2) commit-or-discard the .gsd/ changes manually; (3) re-run.`,
    );
  }
}

describe("auto-worktree nothing-to-commit safety: .gsd/-only sibling check (M002/S03/T02)", () => {
  test("PRE-FIX REPRO — non-.gsd/ filter ONLY: a .gsd/-only numstat is silently allowed (the bug)", () => {
    const numstat: Numstat[] = [
      { added: 5, removed: 1, path: ".gsd/SUMMARY.md" },
    ];
    let threw = false;
    try {
      preFixNothingToCommitGuard(numstat);
    } catch {
      threw = true;
    }
    assert.equal(
      threw,
      false,
      "PRE-FIX guard does NOT throw on .gsd/-only numstat — this is the silent-data-loss bug shape",
    );
  });

  test("POST-FIX — sibling .gsd/-only branch throws GSDError(GSD_GIT_ERROR, …) with operator message", () => {
    const numstat: Numstat[] = [
      { added: 5, removed: 1, path: ".gsd/SUMMARY.md" },
    ];
    let caught: unknown = null;
    try {
      postFixNothingToCommitGuard(numstat);
    } catch (e) {
      caught = e;
    }
    assert.ok(caught instanceof GSDError, "throws GSDError");
    const err = caught as GSDError;
    assert.equal(err.code, GSD_GIT_ERROR, "code === GSD_GIT_ERROR");
    assert.match(err.message, /\.gsd\/SUMMARY\.md/, "message contains the .gsd/ path");
    assert.match(err.message, /1 \.gsd\/ file/, "message reports correct count");
    assert.match(err.message, /Remediation: \(1\)/, "message includes 3-step remediation");
    assert.match(err.message, /git diff main\.\.\.milestone\/M002 -- \.gsd\//, "remediation step 1 includes the diff command");
  });

  test("REGRESSION GUARD — non-.gsd/ entries still trigger the existing 9b throw (additive, not destructive)", () => {
    const numstat: Numstat[] = [
      { added: 10, removed: 0, path: "src/auth.ts" },
      { added: 4, removed: 2, path: "src/utils.ts" },
    ];
    let caught: unknown = null;
    try {
      postFixNothingToCommitGuard(numstat);
    } catch (e) {
      caught = e;
    }
    assert.ok(caught instanceof GSDError, "throws GSDError");
    const err = caught as GSDError;
    assert.equal(err.code, GSD_GIT_ERROR, "code === GSD_GIT_ERROR");
    assert.match(err.message, /2 code file\(s\)/, "message reports non-.gsd/ count via existing 9b branch");
    assert.doesNotMatch(err.message, /Remediation: \(1\)/, "remediation marker is exclusive to the .gsd/-only branch");
  });

  test("SAMPLE TRUNCATION — 5 .gsd/ entries: message lists first 3 with `, …` suffix and reports count 5", () => {
    const numstat: Numstat[] = [
      { added: 1, removed: 0, path: ".gsd/milestones/M002/SUMMARY.md" },
      { added: 1, removed: 0, path: ".gsd/milestones/M002/slices/S01/S01-SUMMARY.md" },
      { added: 1, removed: 0, path: ".gsd/milestones/M002/slices/S02/S02-SUMMARY.md" },
      { added: 1, removed: 0, path: ".gsd/milestones/M002/slices/S03/S03-SUMMARY.md" },
      { added: 1, removed: 0, path: ".gsd/ROADMAP.md" },
    ];
    let caught: unknown = null;
    try {
      postFixNothingToCommitGuard(numstat);
    } catch (e) {
      caught = e;
    }
    assert.ok(caught instanceof GSDError, "throws GSDError");
    const err = caught as GSDError;
    assert.match(err.message, /5 \.gsd\/ file/, "reports count 5");
    assert.match(err.message, /\.gsd\/milestones\/M002\/SUMMARY\.md/, "first sample path present");
    assert.match(err.message, /\.gsd\/milestones\/M002\/slices\/S01\/S01-SUMMARY\.md/, "second sample path present");
    assert.match(err.message, /\.gsd\/milestones\/M002\/slices\/S02\/S02-SUMMARY\.md/, "third sample path present");
    assert.match(err.message, /, …\)/, "truncation suffix `, …` present");
    assert.doesNotMatch(err.message, /S03-SUMMARY\.md/, "fourth sample path NOT present (truncated)");
  });

  test("EMPTY NUMSTAT — neither check fires (safe teardown path preserved)", () => {
    let threw = false;
    try {
      postFixNothingToCommitGuard([]);
    } catch {
      threw = true;
    }
    assert.equal(threw, false, "empty numstat is safe — no throw");
  });

  test("PRODUCTION SOURCE GUARD — auto-worktree.ts contains the 9b-ii sibling block", () => {
    // Encode the requirement that the production fix exists.  If a future
    // refactor silently deletes the sibling block, this guard fires.
    const here = dirname(fileURLToPath(import.meta.url));
    // dist-test layout: dist-test/src/resources/extensions/gsd/tests/this-file.js
    // Source file:      src/resources/extensions/gsd/auto-worktree.ts
    // Both compiled and source-tree forms resolve via project root.
    const candidates = [
      join(here, "..", "auto-worktree.ts"),
      join(here, "..", "auto-worktree.js"),
      join(here, "..", "..", "..", "..", "..", "..", "src", "resources", "extensions", "gsd", "auto-worktree.ts"),
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
      /9b-ii\. Sibling safety check/,
      "production source contains the 9b-ii sibling .gsd/-only safety check (M002/S03/T02 fix)",
    );
    assert.match(
      source!,
      /entry\.path\.startsWith\("\.gsd\/"\)/,
      "production source filters numstat for .gsd/-prefixed paths",
    );
  });
});
