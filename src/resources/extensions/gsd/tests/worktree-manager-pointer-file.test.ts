// GSD Extension — `.git`-pointer-aware internal-dir cleanup test
// (M003/S03 Bug 4, D004 reproduce-and-prevent, real-fs per D005).
//
// The bug: when `removeWorktree` is invoked from inside a worktree
// (`basePath` = worktree path), its `.git` is a pointer FILE pointing at
// `<main>/.git/worktrees/<name>`, not a directory containing `worktrees/`.
// The pre-fix inline `join(basePath, '.git', 'worktrees', name)` resolves
// to a non-existent file path → `existsSync` returns false → silent no-op
// → the real internal dir at `<main>/.git/worktrees/<name>` orphans.
// (#2821 stale-orphan path.)
//
// Strategy (real-fs per D005): build a real main repo + real worktree via
// `git init` and `git worktree add`, plant an untracked file inside the
// worktree so that `git worktree remove` (non-force AND force) refuses,
// then call `removeWorktree(basePath = WORKTREE_PATH, name)` so that
// `basePath/.git` is a pointer file. Assert that after the call:
//   1. The git internal dir at `<main>/.git/worktrees/<name>` is removed.
//   2. The worktree filesystem directory is removed.
//
// Pre-fix: assertion 1 fails because the pre-fix path doesn't reach
// `<main>/.git/worktrees/<name>` from the pointer-file basePath, so the
// internal dir survives as orphan metadata.
//
// Post-fix: `worktreeInternalDir(basePath, name)` resolves via
// `git rev-parse --git-common-dir`, which works for both pointer-file
// and directory `.git`, so the internal dir is correctly removed.
//
// Source-guard subtest (per D011): static-string check that the
// `worktree-manager.ts` cleanup site uses `worktreeInternalDir` (or
// `git rev-parse --git-common-dir`) rather than the bare
// `join(basePath, ".git", "worktrees", name)` — guards against silent
// regressions if a future refactor reverts the resolution.

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync, execSync } from "node:child_process";

import { removeWorktree } from "../worktree-manager.ts";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gsd-wt-pointer-file-"));
}

function cleanupDir(dirPath: string): void {
  try { fs.rmSync(dirPath, { recursive: true, force: true }); } catch { /* best effort */ }
}

function run(command: string, cwd: string): void {
  execSync(command, { cwd, stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * Build a real main repo and a real worktree under `<base>/.gsd/worktrees/<name>`.
 * Returns `{ base, wtPath, internalDir }`.
 */
function makeRepoWithWorktree(name: string): {
  base: string;
  wtPath: string;
  internalDir: string;
} {
  const base = tempDir();
  run("git init -b main -q", base);
  run('git config user.name "Test"', base);
  run('git config user.email "test@example.com"', base);
  fs.writeFileSync(path.join(base, "README.md"), "# main\n", "utf-8");
  run("git add .", base);
  run('git commit -q -m "init"', base);

  const wtPath = path.join(base, ".gsd", "worktrees", name);
  fs.mkdirSync(path.dirname(wtPath), { recursive: true });
  run(`git worktree add -b worktree/${name} -q "${wtPath}"`, base);

  // Lock the worktree so BOTH `git worktree remove` and
  // `git worktree remove --force` refuse (modern git removes untracked
  // files under --force, so untracked planting alone doesn't drive the
  // cleanup branch). A locked worktree only yields to `remove -f -f`,
  // which `nativeWorktreeRemove` does NOT pass — so we fall through to
  // the internal-dir cleanup branch (the L763 site under fix).
  run(`git worktree lock --reason "test" "${wtPath}"`, base);

  const internalDir = path.join(base, ".git", "worktrees", name);
  return { base, wtPath, internalDir };
}

// HARDENING NOTE (D011 R017 caveat): the production call graph for
// `removeWorktree` calls `normalizeBasePathForWorktreeOps(basePath)` at the
// top, which resolves a worktree path BACK to the main repo before the
// L763-region cleanup runs — so the orphan-via-pointer-file path is not
// reachable via the public API in current callers. Bug 4's fix is therefore
// DEFENSE-IN-DEPTH: it ensures the internal-dir resolution remains
// pointer-file-safe even if a future caller (or refactor) bypasses
// `normalizeBasePathForWorktreeOps`. The end-to-end live test below
// exercises the public API and may pass under both the pre-fix and post-fix
// shapes for that reason; the SOURCE-GUARD subtest is the primary D004
// regression evidence — it fails under any revert that re-introduces the
// bare inline join.

test("worktree-manager: removeWorktree(basePath=WORKTREE_PATH, name) cleans `<main>/.git/worktrees/<name>` (M003/S03 Bug 4 — end-to-end smoke)", (t) => {
  let gitOk = true;
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
  } catch {
    gitOk = false;
  }
  if (!gitOk) {
    t.diagnostic("git not available; skipping pointer-file test");
    return;
  }

  let base: string | null = null;
  let wtPath: string | null = null;
  let internalDir: string | null = null;
  try {
    const built = makeRepoWithWorktree("ptrfile");
    base = built.base;
    wtPath = built.wtPath;
    internalDir = built.internalDir;
  } catch (e) {
    t.diagnostic(`could not build worktree fixture (${(e as Error).message}); skipping`);
    return;
  }

  t.after(() => {
    if (base) cleanupDir(base);
  });

  // Sanity: the worktree exists, its `.git` is a pointer FILE (not a dir),
  // and the git internal dir is present before removal.
  assert.ok(fs.existsSync(wtPath!), "fixture: worktree path should exist");
  const dotGitStat = fs.lstatSync(path.join(wtPath!, ".git"));
  assert.ok(dotGitStat.isFile(),
    "fixture: worktree's .git must be a pointer FILE for this test to be meaningful");
  assert.ok(fs.existsSync(internalDir!),
    `fixture: <main>/.git/worktrees/${path.basename(internalDir!)} should exist`);

  // The bug path: invoke removeWorktree with `basePath` = the WORKTREE path
  // (not the main repo). This is the case where the pre-fix code's
  // `join(basePath, ".git", "worktrees", name)` resolved to a non-existent
  // file path under the pointer-file `.git`, silently no-op'ing.
  //
  // We pass `name = "ptrfile"` (the same name the worktree was created
  // with). `removeWorktree` will call `nativeWorktreeRemove`, which tries
  // non-force then force — both refuse because of UNTRACKED.txt → it
  // falls through to the internal-dir + filesystem cleanup branch (L763
  // region) which is the path under fix.
  removeWorktree(wtPath!, "ptrfile", { deleteBranch: false, force: true });

  // Post-fix: the resolution helper finds `<main>/.git/worktrees/ptrfile`
  // via `git rev-parse --git-common-dir` from the pointer-file basePath,
  // so the internal dir is removed.
  //
  // Pre-fix: the inline join produced
  // `<wtPath>/.git/worktrees/ptrfile` which never existed → no-op → the
  // internal dir survives this assertion.
  assert.ok(!fs.existsSync(internalDir!),
    `expected git internal dir <main>/.git/worktrees/ptrfile to be removed; ` +
    `still exists at ${internalDir} — D004 RED proves Bug 4 silent-orphan path.`);

  // The filesystem worktree directory should also be removed by the same
  // cleanup branch.
  assert.ok(!fs.existsSync(wtPath!),
    `expected worktree filesystem dir to be removed; still exists at ${wtPath}`);
});

test("worktree-manager: pointer-file cleanup site uses git-common-dir resolver (Bug 4 source-guard)", () => {
  // R017 / D011 hardening guard: the L763-region cleanup must use the
  // `worktreeInternalDir` helper (or another `git rev-parse --git-common-dir`
  // -based resolution), not the bare inline join. This subtest catches
  // silent regressions if a future edit reverts the fix.
  const src = fs.readFileSync(
    path.join(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname), "..", "worktree-manager.ts"),
    "utf-8",
  );

  // The fixed cleanup branch should reference the resolution helper.
  assert.ok(
    /worktreeInternalDir\(basePath,\s*name\)/.test(src),
    "expected worktree-manager.ts to call `worktreeInternalDir(basePath, name)` for internal-dir cleanup",
  );

  // The resolver itself must shell out to `git rev-parse --git-common-dir`.
  assert.ok(
    /rev-parse[^"]*"[^"]*--git-common-dir/.test(src) ||
      /"--git-common-dir"/.test(src),
    "expected gitCommonDir to call `git rev-parse --git-common-dir`",
  );

  // The bare pre-fix inline join must NOT appear as ACTIVE CODE inside
  // the file. Strip /* … */ block comments and `//` line comments first
  // so that documentation references to the old shape do not trip the
  // regression guard.
  const codeOnly = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
  const bareInlineJoin = codeOnly.match(
    /join\(\s*basePath\s*,\s*["']\.git["']\s*,\s*["']worktrees["']\s*,\s*name\s*\)/,
  );
  assert.equal(
    bareInlineJoin,
    null,
    "regression: `join(basePath, '.git', 'worktrees', name)` must not appear in active code — use worktreeInternalDir() so pointer-file basePaths resolve correctly",
  );
});
