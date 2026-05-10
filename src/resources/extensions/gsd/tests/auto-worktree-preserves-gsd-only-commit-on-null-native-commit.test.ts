/**
 * auto-worktree-preserves-gsd-only-commit-on-null-native-commit.test.ts
 * — M002/S03/T02 BEHAVIORAL test (CRITICAL-bar per D007/MEM040)
 *
 * Bug: `auto-worktree.ts:2074-2076` — when `nativeCommit` returns null
 * ("nothing to commit") and the milestone branch differs from `main` by
 * ONLY `.gsd/`-prefixed files (libgit2 hiccup, unicode-only diff git CLI
 * cannot see, or genuine metadata-only milestone), the existing 9b safety
 * check at lines 2167-2186 (filtering numstat for non-`.gsd/` paths)
 * silently allowed teardown to proceed and the milestone's `.gsd/` work
 * was destroyed.
 *
 * Fix: `9b-ii` SIBLING safety check immediately after the existing 9b
 * branch — filters numstat for `.gsd/`-prefixed paths and throws GSDError
 * with operator-facing message before teardown.
 *
 * BEHAVIORAL strategy (real-git fixture + D005 test seams from
 * `_setNativeCommitForTests` / `_setNativeDiffNumstatForTests` in
 * `native-git-bridge.ts`):
 *   1. Build a real git repo + auto-worktree containing `.gsd/` work
 *      committed on the milestone branch but NOT on main.
 *   2. Stub `nativeCommit→null` to simulate the libgit2 "nothing to
 *      commit" hiccup that triggers the bug window.
 *   3. Stub `nativeDiffNumstat` to return ONLY `.gsd/`-prefixed entries
 *      (the symptom shape — what would happen on a unicode-only diff or
 *      a metadata-only milestone where libgit2 disagrees with CLI).
 *   4. Drive `mergeMilestoneToMain` (REAL, not mocked).
 *   5. Assert: (a) GSDError thrown with operator-facing message containing
 *      file count + first 3 sample paths + 3-step remediation; (b) the
 *      worktree directory still exists (teardown aborted); (c) the `.gsd/`
 *      content is preserved on the milestone branch (no data loss).
 *
 * Fixture template: `parallel-merge-rejects-malicious-worktree-name.test.ts`
 * for the seam-injection pattern; `integration/auto-worktree-milestone-merge.test.ts`
 * for the real-git tmp-repo + auto-worktree wiring (`createTempRepo`,
 * `addSliceToMilestone`).
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
import { GSDError, GSD_GIT_ERROR } from "../errors.ts";

function run(cmd: string, args: string[], cwd: string): string {
  return execFileSync(cmd, args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
  }).trim();
}

function createTempRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "wt-gsd-only-safety-")));
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
  return `# ${milestoneId}: Metadata-only milestone\n\n## Slices\n- [x] **S01: docs**\n`;
}

test("mergeMilestoneToMain refuses to tear down worktree when nativeCommit→null but .gsd/ files differ (M002/S03/T02 #bug-list-line-31)", { timeout: 60_000 }, (t) => {
  const savedCwd = process.cwd();
  const repo = createTempRepo();

  // Make sure even a re-entrant test run starts from a clean originalBase slot.
  _resetAutoWorktreeOriginalBaseForTests();

  // Create the auto-worktree (real). This sets the milestone branch up.
  const wtPath = createAutoWorktree(repo, "M999");

  // Commit some `.gsd/` work on the milestone branch — this represents the
  // metadata-only milestone whose work would be silently lost without the
  // 9b-ii sibling check.
  const summaryPath = join(wtPath, ".gsd", "milestones");
  mkdirSync(summaryPath, { recursive: true });
  const sentinelPath = join(summaryPath, "M999-SUMMARY.md");
  writeFileSync(sentinelPath, "# M999 SUMMARY\n\nthis is the milestone work that must NOT be lost\n");
  run("git", ["add", "-A"], wtPath);
  run("git", ["commit", "-m", "docs(M999): add summary"], wtPath);

  const milestoneBranch = "milestone/M999";
  const milestoneCommitBefore = run("git", ["rev-parse", milestoneBranch], repo);

  // D005 seam-injection (mirrors _setSqliteRunnerForTests pattern in
  // parallel-sqlite-cli.ts). Simulate the libgit2 hiccup window:
  //   - nativeCommit returns null (the staged squash produced nothing the
  //     committer recognized).
  //   - numstat reports ONLY .gsd/ entries (the diff that the existing 9b
  //     non-.gsd/ filter erroneously treated as safe-to-teardown).
  let commitCalls = 0;
  let numstatCalls = 0;
  _setNativeCommitForTests(() => {
    commitCalls++;
    return null;
  });
  _setNativeDiffNumstatForTests(() => {
    numstatCalls++;
    return [
      { added: 5, removed: 0, path: ".gsd/milestones/M999-SUMMARY.md" },
      { added: 2, removed: 1, path: ".gsd/STATE.md" },
    ];
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

  // (a) GSDError thrown with operator-facing message
  assert.ok(caught instanceof GSDError, `expected GSDError, got: ${caught instanceof Error ? caught.message : String(caught)}`);
  const err = caught as GSDError;
  assert.equal(err.code, GSD_GIT_ERROR, "code === GSD_GIT_ERROR");
  assert.match(err.message, /2 \.gsd\/ file/, "message reports correct .gsd/ file count");
  assert.match(err.message, /\.gsd\/milestones\/M999-SUMMARY\.md/, "message includes first .gsd/ sample path");
  assert.match(err.message, /\.gsd\/STATE\.md/, "message includes second .gsd/ sample path");
  assert.match(err.message, /Remediation: \(1\)/, "message includes 3-step remediation");
  assert.match(err.message, /git diff main\.\.\.milestone\/M999 -- \.gsd\//, "remediation step 1 includes the diff command");

  // Sanity: the seams were actually invoked by the production code path —
  // proves we exercised the real teardown sequence, not a stub.
  assert.ok(commitCalls >= 1, "production code reached nativeCommit (seam called)");
  assert.ok(numstatCalls >= 1, "production code reached nativeDiffNumstat (seam called)");

  // (b) Worktree directory still exists — teardown was aborted before
  // the worktree directory was removed.
  const worktreeDir = join(repo, ".gsd", "worktrees", "M999");
  assert.ok(existsSync(worktreeDir), "worktree directory survives — teardown aborted");

  // (c) `.gsd/` content preserved on the milestone branch.
  const milestoneCommitAfter = run("git", ["rev-parse", milestoneBranch], repo);
  assert.equal(milestoneCommitAfter, milestoneCommitBefore, "milestone branch tip unchanged — work preserved");

  // The sentinel file is still present in the worktree (the worktree was
  // not torn down, so the working tree still holds the .gsd/ work).
  assert.ok(existsSync(sentinelPath), "sentinel `.gsd/milestones/M999-SUMMARY.md` survives in worktree");
  const sentinelContent = readFileSync(sentinelPath, "utf8");
  assert.match(sentinelContent, /this is the milestone work that must NOT be lost/, "sentinel content intact");
});
