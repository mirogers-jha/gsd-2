/**
 * D004: worktree-root resolveProjectRootFromPath null-on-symlinked-external
 *
 * Bug 2 from S04 — when input is a symlinked-external `~/.gsd/projects/<hash>/worktrees/...`
 * path with no `.git` file, `resolveProjectRootFromPath` previously returned the input
 * itself, causing writes/reads to land in `~/.gsd/projects/<hash>/...` instead of the
 * real project root. Fix: return null and let callers fall back to the input.
 *
 * Per D011, classify as HARDENING M003/S04 — pre-fix theoretical only (no observed
 * production divergence). R017 caveat: degenerate at the public boundary because
 * `resolveWorktreeProjectRoot` re-injects the input via `?? fallback`. The behavioral
 * value is in the source-guard test (sub-test C, MEM060) which prevents regression
 * to the silent-divergence variant.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveWorktreeProjectRoot } from "../worktree-root.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// dist-test/.../tests -> repo source `worktree-root.ts` for MEM060 source-guard.
const SOURCE_PATH = resolve(__dirname, "..", "..", "..", "..", "..", "..", "src", "resources", "extensions", "gsd", "worktree-root.ts");

function withScrubbedEnv(t: import("node:test").TestContext): { tmpHome: string; cleanup: () => void } {
  // MEM035: scrub inherited GSD_PROJECT_ROOT before any path resolution.
  const prevProjectRoot = process.env.GSD_PROJECT_ROOT;
  const prevGsdHome = process.env.GSD_HOME;
  delete process.env.GSD_PROJECT_ROOT;

  // MEM079: realpathSync(mkdtempSync(...)) so /var/folders matches /private/var/folders.
  const tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), "wt-root-symex-")));
  const tmpHome = join(tmpRoot, ".gsd");
  mkdirSync(tmpHome, { recursive: true });
  process.env.GSD_HOME = tmpHome;

  const cleanup = () => {
    if (prevProjectRoot === undefined) {
      delete process.env.GSD_PROJECT_ROOT;
    } else {
      process.env.GSD_PROJECT_ROOT = prevProjectRoot;
    }
    if (prevGsdHome === undefined) {
      delete process.env.GSD_HOME;
    } else {
      process.env.GSD_HOME = prevGsdHome;
    }
    rmSync(tmpRoot, { recursive: true, force: true });
  };
  t.after(cleanup);
  return { tmpHome, cleanup };
}

test("Sub-test A: symlinked-external worktree path with no .git falls back to input at public boundary (R017 degenerate)", (t) => {
  const { tmpHome } = withScrubbedEnv(t);
  // Layout: <tmpHome>/projects/<hash>/worktrees/M999-test/  (no .git file)
  const projectHash = "abc123";
  const worktreePath = join(tmpHome, "projects", projectHash, "worktrees", "M999-test");
  mkdirSync(worktreePath, { recursive: true });

  const result = resolveWorktreeProjectRoot(worktreePath, undefined);

  // R017 caveat: post-fix returns the input via `?? fallback` at the public boundary.
  // Pre-fix would have returned the same thing too — but pre-fix the inner helper
  // returned the symlinked-external path AS the "real" project root, so the silent
  // divergence happened invisibly. Source-guard sub-test C is the behavioral assertion.
  assert.equal(result, worktreePath, "public boundary returns input as fallback (degenerate)");
});

test("Sub-test B: non-symlinked-external real worktree resolves to real project root (regression)", (t) => {
  const { tmpHome: _ignored } = withScrubbedEnv(t);
  void _ignored;

  // Build a separate real project layout outside <tmpHome>/projects/.
  const projectRoot = realpathSync(mkdtempSync(join(tmpdir(), "wt-root-real-")));
  const dotGit = join(projectRoot, ".git");
  mkdirSync(dotGit, { recursive: true });
  // Worktree at <projectRoot>/.gsd/worktrees/M999-test/ with a .git file pointing back.
  const worktreePath = join(projectRoot, ".gsd", "worktrees", "M999-test");
  mkdirSync(worktreePath, { recursive: true });
  // Realistic .git file: gitdir: <projectRoot>/.git/worktrees/M999-test
  const wtGitDir = join(dotGit, "worktrees", "M999-test");
  mkdirSync(wtGitDir, { recursive: true });
  writeFileSync(join(worktreePath, ".git"), `gitdir: ${wtGitDir}\n`, "utf8");

  t.after(() => rmSync(projectRoot, { recursive: true, force: true }));

  const result = resolveWorktreeProjectRoot(worktreePath, undefined);
  assert.equal(result, projectRoot, "real worktree resolves to its real project root");
});

test("Sub-test C: MEM060 source-guard — symlinked-external branch returns realRoot (not realRoot ?? path)", () => {
  const source = readFileSync(SOURCE_PATH, "utf8");

  // Locate the symlinked-external branch and verify the literal post-fix shape.
  // Pre-fix:  return realRoot ?? path;
  // Post-fix: return realRoot;
  // Regex anchors to the line in resolveProjectRootFromPath after the candidateGsdPath comparison.
  const branchMatch = source.match(
    /candidateGsdPath\s*===\s*gsdHomeNorm[\s\S]{0,400}?const\s+realRoot\s*=\s*resolveProjectRootFromGitFile\(path\);\s*\n\s*return\s+realRoot;\s*\n/,
  );
  assert.ok(
    branchMatch,
    "expected `return realRoot;` (without `?? path`) in the symlinked-external branch — see D011 hardening / Bug 2",
  );

  // Negative guard: ensure the regression form is not present anywhere in this helper.
  assert.ok(
    !/return\s+realRoot\s*\?\?\s*path\s*;/.test(source),
    "regression: `return realRoot ?? path;` would silently route writes to ~/.gsd/projects/<hash>/...",
  );
});
