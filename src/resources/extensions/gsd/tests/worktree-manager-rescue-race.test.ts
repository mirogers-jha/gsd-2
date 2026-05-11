// GSD Extension — worktree-manager rescue-chain race test
// (M003/S03 Bug 3, D004 reproduce-and-prevent, D008/MEM074 seam, MEM069 pattern).
//
// The bug: pre-fix `removeWorktree`'s submodule-rescue chain
// (worktree-manager.ts L561-606 region) shells out to `git submodule status`,
// `git add`, `git commit`, `git branch` via `execFileSync` WITHOUT any lock.
// Two concurrent `removeWorktree('foo')` invocations on the same worktree
// name interleave those calls and corrupt shared `.git` refs (duplicated
// rescue branches, branch refs that race against each other to point at the
// rescue commit).
//
// Strategy (D008 spawn seam + MEM069 in-injection re-entry):
// inject the rescue chain's `execFileSync` via `_setRemoveWorktreeSpawnForTests`.
// The injected version (a) increments a shared "rescue depth" counter on entry
// and decrements on exit, (b) on the FIRST entry only, synchronously plants a
// concurrent `removeWorktree('foo')` call that would race the rescue chain.
//
// Pre-fix the planted re-entry is unguarded → it gets all the way through
// to the same chain → the depth counter shows two simultaneous active rescues
// (max depth >= 2) → race observable.
//
// Post-fix the planted re-entry hits the outer `withFileLockSync` and ELOCKEDs
// because proper-lockfile rejects same-process re-entry — the rescue chain
// throws GSDError(GSD_LOCK_HELD, …) → max depth stays at 1 → race prevented.
//
// This is the same in-injection re-entry pattern proven on M003/S01 Bug 1
// (workflow-events-append-race.test.ts) and documented in MEM069.

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync, execFileSync } from "node:child_process";

import {
  removeWorktree,
  _setRemoveWorktreeSpawnForTests,
  _resetRemoveWorktreeSpawnForTests,
} from "../worktree-manager.ts";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gsd-wt-rescue-race-"));
}

function cleanupDir(dirPath: string): void {
  try { fs.rmSync(dirPath, { recursive: true, force: true }); } catch { /* best effort */ }
}

function run(command: string, cwd: string): void {
  execSync(command, { cwd, stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * Build a minimal main repo + a worktree under .gsd/worktrees/<name> that
 * contains a real submodule with uncommitted changes. The submodule changes
 * are what drive `removeWorktree` into the rescue chain we want to lock.
 */
function makeRepoWithSubmoduleWorktree(worktreeName: string): {
  base: string;
  wtPath: string;
} {
  const base = tempDir();
  run("git init -b main -q", base);
  run('git config user.name "Test"', base);
  run('git config user.email "test@example.com"', base);
  // Allow `git submodule add` against a local file:// path on modern git.
  run("git config protocol.file.allow always", base);

  fs.writeFileSync(path.join(base, "README.md"), "# main\n", "utf-8");
  run("git add .", base);
  run('git commit -q -m "init"', base);

  // Build a tiny inner repo to be used as the submodule source.
  const innerSrc = tempDir();
  run("git init -b main -q", innerSrc);
  run('git config user.name "Test"', innerSrc);
  run('git config user.email "test@example.com"', innerSrc);
  fs.writeFileSync(path.join(innerSrc, "x.txt"), "x\n", "utf-8");
  run("git add .", innerSrc);
  run('git commit -q -m "inner init"', innerSrc);

  // Create the worktree.
  const wtPath = path.join(base, ".gsd", "worktrees", worktreeName);
  fs.mkdirSync(path.dirname(wtPath), { recursive: true });
  run(`git worktree add -b worktree/${worktreeName} -q "${wtPath}"`, base);
  // Per-worktree git config so submodule add works inside the worktree.
  run('git config user.name "Test"', wtPath);
  run('git config user.email "test@example.com"', wtPath);
  run("git config protocol.file.allow always", wtPath);

  // Add the submodule INSIDE the worktree, then dirty it so
  // `git submodule status` reports the `+`/`-` prefix that triggers the
  // rescue chain. Use -c to bypass git's file:// transport guard regardless
  // of the user's global config.
  run(`git -c protocol.file.allow=always submodule add -q "${innerSrc}" sub`, wtPath);
  run('git commit -q -m "add submodule"', wtPath);
  // Mutate the submodule HEAD without committing — produces a `+` line.
  fs.appendFileSync(path.join(wtPath, "sub", "x.txt"), "dirty\n", "utf-8");
  run("git add x.txt", path.join(wtPath, "sub"));
  run('git commit -q -m "submodule dirty"', path.join(wtPath, "sub"));

  return { base, wtPath };
}

test("worktree-manager: rescue chain serializes concurrent removeWorktree (M003/S03 Bug 3)", (t) => {
  // Skip on environments without git or where the file-lock primitive cannot
  // operate — the wrap is still exercised statically by typecheck and the
  // source-guard subtest below.
  let gitOk = true;
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
  } catch {
    gitOk = false;
  }
  if (!gitOk) {
    t.diagnostic("git not available; skipping live race test");
    return;
  }

  let base: string | null = null;
  let wtPath: string | null = null;
  try {
    const built = makeRepoWithSubmoduleWorktree("racey");
    base = built.base;
    wtPath = built.wtPath;
  } catch (e) {
    t.diagnostic(`could not build submodule fixture (${(e as Error).message}); skipping`);
    return;
  }

  t.after(() => {
    _resetRemoveWorktreeSpawnForTests();
    if (base) cleanupDir(base);
  });

  let depth = 0;
  let maxDepth = 0;
  let planted = false;
  let plantedThrew = false;
  let plantedThrewLockHeld = false;
  let injectedCalls = 0;

  _setRemoveWorktreeSpawnForTests(((file: any, args: any, options: any) => {
    injectedCalls += 1;
    depth += 1;
    if (depth > maxDepth) maxDepth = depth;
    try {
      // Plant ONCE on the first invocation: re-enter `removeWorktree` for the
      // SAME worktree name so we observe whether the second call's rescue
      // chain interleaves with the first.
      if (!planted) {
        planted = true;
        try {
          // Re-enter. Post-fix this path's withFileLockSync ELOCKEDs because
          // we already hold the same lockfile via proper-lockfile (which
          // rejects same-process re-entry). Pre-fix this path executes the
          // rescue chain → seam re-fires → depth ascends to 2.
          removeWorktree(base!, "racey", { deleteBranch: false, force: true });
        } catch (err: any) {
          plantedThrew = true;
          if (err?.code === "GSD_LOCK_HELD") plantedThrewLockHeld = true;
        }
      }
      // Delegate to the real binary so the outer call still makes progress.
      return execFileSync(file, args, options);
    } finally {
      depth -= 1;
    }
  }) as typeof execFileSync);

  // Drive the rescue chain.
  try {
    removeWorktree(base, "racey", { deleteBranch: false, force: true });
  } catch (err: any) {
    // The outer call should NOT throw because it owns the lock and runs the
    // rescue chain to completion. If it did throw, that's a real regression
    // — surface it explicitly.
    assert.fail(`outer removeWorktree threw unexpectedly: ${err?.code ?? ""} ${err?.message ?? err}`);
  }

  _resetRemoveWorktreeSpawnForTests();

  // Plumbing guard: the seam must have fired at least once. Without this
  // a future regression that bypasses the seam would let the test pass
  // trivially.
  assert.ok(injectedCalls >= 1,
    `expected the injected rescue spawn to fire at least once; got ${injectedCalls}`);
  assert.ok(planted,
    "expected the in-injection re-entry to be planted; it was not");

  // Post-fix invariant 1: the planted re-entry must throw GSD_LOCK_HELD
  // because the outer rescue chain holds the worktree-rescue lockfile and
  // proper-lockfile rejects same-process re-entry. Pre-fix this fails
  // (planted re-entry runs without contention).
  assert.ok(plantedThrew,
    "post-fix: the planted re-entry must throw — it did not (rescue chain is NOT serialized)");
  assert.ok(plantedThrewLockHeld,
    "post-fix: the planted re-entry must throw GSD_LOCK_HELD specifically — " +
    "the rescue chain is NOT wrapped in withFileLockSync, or the wrapper does " +
    "not raise GSDError(GSD_LOCK_HELD) on contention");

  // Post-fix invariant 2: the rescue chain depth must NEVER exceed 1 —
  // i.e. only one rescue chain is active at any time. Pre-fix this fails
  // (depth >= 2 because the planted re-entry runs inside the seam, both
  // calls are active simultaneously).
  assert.strictEqual(maxDepth, 1,
    `post-fix: maxDepth must be 1 (single-flight rescue chain); got ${maxDepth} ` +
    `(rescue chain interleaves — race window is open)`);
});

test("worktree-manager: source-guard for rescue-chain lock wrap (M003/S03 Bug 3, MEM060)", () => {
  // Defense in depth: even on platforms or harness configurations where the
  // live race test above is skipped, this source-guard confirms the wrap
  // is in place at the call site. A regression that removes the wrap would
  // fail this assertion in addition to (or instead of) the live test.
  const url = new URL("../worktree-manager.ts", import.meta.url);
  const source = fs.readFileSync(url, "utf-8");

  // Required: import + lock-path resolver + the wrap on the rescue chain.
  assert.match(source, /from "\.\/file-lock\.js"/,
    "source-guard: worktree-manager must import withFileLockSync from file-lock.js");
  assert.match(source, /function rescueLockPath\(/,
    "source-guard: rescueLockPath helper must exist");
  assert.match(source, /git rev-parse --git-common-dir|"--git-common-dir"/,
    "source-guard: rescueLockPath must use git rev-parse --git-common-dir to find the main repo");
  assert.match(source, /withFileLockSync\(lockPath, \(\) => \{/,
    "source-guard: rescue chain must be wrapped in withFileLockSync(lockPath, () => { ... })");
  assert.match(source, /_setRemoveWorktreeSpawnForTests/,
    "source-guard: D008 seam _setRemoveWorktreeSpawnForTests must be exported");
  assert.match(source, /_resetRemoveWorktreeSpawnForTests/,
    "source-guard: D008 seam _resetRemoveWorktreeSpawnForTests must be exported");
  assert.match(source, /GSD_LOCK_HELD/,
    "source-guard: rescue chain must surface contention as GSDError(GSD_LOCK_HELD, …)");
});

test("worktree-manager: _setRemoveWorktreeSpawnForTests / _reset… restore default behavior", () => {
  let intercepted = 0;
  _setRemoveWorktreeSpawnForTests(((file: any, args: any, options: any) => {
    intercepted += 1;
    return execFileSync(file, args, options);
  }) as typeof execFileSync);
  // The seam is module-level state; reset must clear it without side effects.
  _resetRemoveWorktreeSpawnForTests();
  // No assertion against `intercepted` — the seam wasn't driven; we just
  // check the reset doesn't throw and that follow-up sets are accepted.
  assert.strictEqual(intercepted, 0, "seam not driven yet");
  _setRemoveWorktreeSpawnForTests(null);
  _resetRemoveWorktreeSpawnForTests();
});
