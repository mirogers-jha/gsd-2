/**
 * auto-worktree-restores-shelter-on-throw.test.ts
 * — M002/S03/T03 BEHAVIORAL test (CRITICAL-bar per D007/MEM040 — HARDENING per D011/MEM044)
 *
 * D011 plan-time investigation outcome [NOT REPRODUCED M002/S03 — hardening
 * shipped]: the originally-claimed leak path
 * (`auto-worktree.ts:2167-2186` throw skips `restoreShelter()` and stash-pop)
 * is BENIGN in current code. `restoreShelter()` runs at 9a-iii unconditionally
 * before the safety throw, and the stash-pop block at 9a-ii also runs before
 * the throw. Both shelter and stash are already restored when the safety
 * check throws today.
 *
 * Per D011/MEM044 we still ship the fix (a `try/finally` envelope around the
 * 9-step squash-merge block) as **defense-in-depth**. CRITICAL-bar mandate
 * applies per D007 file-region scope, so the unit test is paired with a
 * BEHAVIORAL test that exercises the real production teardown sequence on
 * a real-git fixture, then asserts the post-throw filesystem state matches
 * the no-leak contract.
 *
 * BEHAVIORAL strategy (real-git fixture + D005 seam from
 * `_setNativeDiffNumstatForTests` in `native-git-bridge.ts`, mirrors T02
 * fixture template):
 *   1. Build a real git repo + auto-worktree with:
 *        - real `.gsd/milestones/M999-OTHER` shelter source (sibling
 *          milestone dir that gets sheltered during merge — proves shelter
 *          round-trip).
 *        - real dirty/untracked file at the project root that gets stashed
 *          by step 7a (proves stash round-trip).
 *        - real `.gsd/milestones/M999-SUMMARY.md` work committed on the
 *          milestone branch (so the squash merge has something to merge).
 *   2. Stub `nativeDiffNumstat→throw` (D005 seam) — this triggers a throw
 *      AFTER the existing 9a-ii stash-pop and 9a-iii restoreShelter happy-
 *      path call sites already ran (i.e. inside the envelope, between the
 *      last cleanup and the end of step 9b/9b-ii). The envelope's finally
 *      branch should be a documented NO-OP (already-ran guards active),
 *      and the prior happy-path cleanup should have already restored
 *      shelter + popped stash.
 *   3. Drive `mergeMilestoneToMain` (REAL, not mocked).
 *   4. Assert NO-LEAK contract:
 *        (a) the seam throw escapes `mergeMilestoneToMain` (envelope
 *            finally swallows nothing — original error propagates).
 *        (b) the sheltered sibling milestone dir is RESTORED at its
 *            project-root `.gsd/milestones/M999-OTHER` location (shelter
 *            round-trip survived the throw).
 *        (c) the dirty file from step 1's stash is POPPED back into the
 *            project-root working tree (stash round-trip survived the
 *            throw).
 *        (d) the shelter directory `.milestone-shelter/` is cleaned up
 *            (no leak of intermediate state).
 *
 * This shape directly tests the envelope's `must-have`: existing happy-path
 * cleanup at :2161 + stash-pop blocks UNCHANGED behavior — envelope is
 * additive. If a future regression deferred any of those existing cleanups
 * past the throw point, the envelope finally would catch it (proven by the
 * unit test); this behavioral test proves the envelope did not BREAK the
 * existing happy-path teardown when a throw happens after happy-path
 * cleanup ran.
 *
 * better-sqlite3 only (NOT Postgres — D012 future override per S03-CONTEXT).
 *
 * R015 compliance: no new dependencies. Real `git` CLI + Node FS only.
 *
 * MEM046 baseline: prefix CI runs with
 *   `env -u GSD_PROJECT_ROOT PATH="$PWD/node_modules/.bin:$PATH"`
 * to avoid worktree-resolver contamination.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  realpathSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

import {
  createAutoWorktree,
  mergeMilestoneToMain,
  _resetAutoWorktreeOriginalBaseForTests,
} from "../auto-worktree.ts";
import {
  _setNativeCommitForTests,
  _setNativeDiffNumstatForTests,
} from "../native-git-bridge.ts";

function run(cmd: string, args: string[], cwd: string): string {
  return execFileSync(cmd, args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
  }).trim();
}

function createTempRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "wt-shelter-throw-")));
  run("git", ["init"], dir);
  run("git", ["config", "user.email", "test@test.com"], dir);
  run("git", ["config", "user.name", "Test"], dir);
  writeFileSync(join(dir, "README.md"), "# test\n");
  mkdirSync(join(dir, ".gsd"), { recursive: true });
  writeFileSync(join(dir, ".gsd", "STATE.md"), "# State\n");
  run("git", ["add", "."], dir);
  run("git", ["commit", "-m", "init"], dir);
  run("git", ["branch", "-M", "main"], dir);
  return dir;
}

function makeRoadmap(milestoneId: string): string {
  return `# ${milestoneId}: Hardening test\n\n## Slices\n- [x] **S01: docs**\n`;
}

test("mergeMilestoneToMain finally envelope: happy-path cleanup at 9a-ii (stash pop) and 9a-iii (restoreShelter) survives a downstream throw inside the envelope (M002/S03/T03 — D011 hardening)", { timeout: 60_000 }, (t) => {
  const savedCwd = process.cwd();
  const repo = createTempRepo();

  _resetAutoWorktreeOriginalBaseForTests();

  // --- Build sibling milestone dir at project root that will be SHELTERED ---
  // The shelter step (7) moves any non-target milestone dir from
  // `.gsd/milestones/<MID>/` into `.gsd/.milestone-shelter/<MID>/` before
  // the squash merge, then restores it at 9a-iii. We track this sibling to
  // prove the shelter round-trip survived the downstream throw.
  const SIBLING_MID = "M999-OTHER";
  const siblingDir = join(repo, ".gsd", "milestones", SIBLING_MID);
  const siblingSentinelPath = join(siblingDir, "PLAN.md");
  const siblingSentinelContent = "# M999-OTHER PLAN — must survive shelter round-trip\n";
  mkdirSync(siblingDir, { recursive: true });
  writeFileSync(siblingSentinelPath, siblingSentinelContent);
  run("git", ["add", "-A"], repo);
  run("git", ["commit", "-m", "seed sibling milestone dir"], repo);

  // Create the auto-worktree (real). Sets up the milestone branch.
  const wtPath = createAutoWorktree(repo, "M999");

  // Commit the milestone's `.gsd/` work on the milestone branch — gives
  // the squash merge real content so the merge proceeds to step 9.
  const summaryDir = join(wtPath, ".gsd", "milestones", "M999");
  mkdirSync(summaryDir, { recursive: true });
  const milestoneSentinel = join(summaryDir, "M999-SUMMARY.md");
  writeFileSync(milestoneSentinel, "# M999 SUMMARY\n");
  run("git", ["add", "-A"], wtPath);
  run("git", ["commit", "-m", "docs(M999): add summary"], wtPath);

  // --- Build a dirty file at project root that step 7a will STASH ---
  // The stash step pre-merge stashes pre-existing dirty files so the squash
  // merge isn't blocked. The 9a-ii block pops the stash after the commit.
  // We track this to prove the stash round-trip survived the downstream
  // throw.
  const stashSentinelPath = join(repo, "stash-sentinel.txt");
  const stashSentinelContent = "must survive stash round-trip\n";
  writeFileSync(stashSentinelPath, stashSentinelContent);

  // D005 seam-injection: force the production teardown sequence into the
  // 9b safety-check window where `nativeDiffNumstat` is called.
  //
  //   1. `_setNativeCommitForTests(() => null)` — forces `nothingToCommit`
  //      true so step 9b runs. (Mirrors T02 behavioral fixture.)
  //   2. `_setNativeDiffNumstatForTests(() => throw)` — throws on the
  //      numstat call inside step 9b. At that point in production:
  //        - 9a-ii (stash pop) has ALREADY run (`stashPopped = true`)
  //        - 9a-iii (restoreShelter) has ALREADY run (`shelterRestored = true`)
  //      so the envelope finally runs as a documented NO-OP (already-ran
  //      guards active). The behavioral assertion is that the prior
  //      happy-path cleanup ALREADY ran and survived the throw — this is
  //      exactly the "envelope is additive, not destructive" contract.
  let commitCalls = 0;
  let numstatCalls = 0;
  _setNativeCommitForTests(() => {
    commitCalls++;
    return null;
  });
  _setNativeDiffNumstatForTests(() => {
    numstatCalls++;
    throw new Error("synthetic numstat throw — M002/S03/T03 behavioral hardening");
  });

  t.after(() => {
    _setNativeCommitForTests(null);
    _setNativeDiffNumstatForTests(null);
    _resetAutoWorktreeOriginalBaseForTests();
    process.chdir(savedCwd);
    try { rmSync(repo, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  let caught: unknown = null;
  try {
    mergeMilestoneToMain(repo, "M999", makeRoadmap("M999"));
  } catch (e) {
    caught = e;
  }

  // (a) Throw escaped — envelope finally did NOT swallow the original error.
  // The throw could be either the synthetic numstat throw OR a downstream
  // throw triggered by the merge sequencing in this fixture; in either
  // case, what matters for the no-leak contract is the post-throw FS state.
  // We additionally assert numstat was reached IF the merge sequence got
  // that far — proving the seam was actually invoked when the merge made
  // it past the commit step.
  assert.ok(caught !== null, `expected a throw to escape mergeMilestoneToMain, got: ${String(caught)}`);

  // (b) Sheltered sibling milestone dir RESTORED to its project-root
  // location. The 9a-iii happy-path call runs unconditionally before the
  // safety check; with the envelope, this remains true and a downstream
  // throw does not strand the sibling in `.milestone-shelter/`.
  const siblingAfter = readFileSync(siblingSentinelPath, "utf8").trim();
  assert.equal(
    siblingAfter,
    siblingSentinelContent.trim(),
    "shelter round-trip preserved — sibling milestone dir restored at project root after envelope-internal throw",
  );

  // (c) Stash round-trip — the dirty file is back in the project-root
  // working tree. Either it was popped (file present with original
  // content) OR it was never staged into the stash (e.g. on this
  // platform/git version it was sheltered another way). What matters for
  // the no-leak contract: the file content is intact.
  const stashAfter = readFileSync(stashSentinelPath, "utf8").trim();
  assert.equal(
    stashAfter,
    stashSentinelContent.trim(),
    "stash round-trip preserved — dirty sentinel file content intact after envelope-internal throw",
  );

  // (d) Shelter intermediate dir cleaned up — no leak of `.milestone-shelter/`
  // from the throw path. The restoreShelter helper rmSyncs it on success;
  // if it survived the throw, that would be a real leak.
  const shelterDir = join(repo, ".gsd", ".milestone-shelter");
  assert.ok(
    !existsSync(shelterDir),
    `shelter intermediate dir cleaned up (no leak) — found at ${shelterDir} which means restoreShelter did not run cleanly`,
  );

  // Sanity: both seams were reached at least once via the production code
  // path — proves the test exercised the envelope-internal throw site we
  // intended (after stash-pop happy path at 9a-ii and shelter restore at
  // 9a-iii had already run).
  assert.ok(
    commitCalls >= 1,
    "production code reached nativeCommit seam at least once",
  );
  assert.ok(
    numstatCalls >= 1,
    "production code reached nativeDiffNumstat seam at least once (envelope-internal throw site exercised)",
  );
});
