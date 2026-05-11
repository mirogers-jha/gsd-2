/**
 * worktree-command-case-collision.test.ts
 *
 * D004 reproduce-and-prevent for M003/S03/T02 (Bug 2).
 *
 * Bug (HIGH-severity, FIXED-candidate per .bugs/bug-list.md): the
 * `/worktree create <name>` and bare-name dispatch flows compared an
 * existing-worktree list against the user-typed name with strict equality
 * at `worktree-command.ts:142` and `:217`. On macOS/Windows the underlying
 * fs is case-insensitive, so a user typing `FOO` when worktree `foo` already
 * exists would (a) miss the collision check, (b) fall through to
 * `handleCreate("FOO")`, and (c) `git worktree add .gsd/worktrees/FOO`
 * would fatal-error because the casefold-collision directory `foo` already
 * exists — the error surfaced as a confusing "Failed to create worktree:
 * fatal: '<path>' already exists" notification (the bug-list calls this the
 * `GSD_STALE_STATE` UX symptom).
 *
 * Fix (T02): replace `existing.some(wt => wt.name === <input>)` at BOTH
 * call-sites with `existing.find(wt => wt.name.toLowerCase() === <input>.toLowerCase())`
 * and route the hit to `handleSwitch(basePath, collision.name, ctx)` —
 * using the EXISTING canonical-cased name. UX is silent graceful switch:
 * no notify, no prompt (matches macOS/Windows fs convention).
 *
 * Per S03-CONTEXT, NO platform detection and NO fs probe — we accept the
 * trade-off that distinct `FOO`/`foo` worktree names are no longer possible
 * on Linux. For milestone-ID-shaped names this never matters in practice.
 *
 * Test strategy: real on-disk tmp git repo (no module mocks — node:test v22
 * has no `mock.module` without --experimental-test-module-mocks, which is
 * not enabled here). Pre-create worktree `alpha`, then exercise both the
 * `switch ALPHA` (line-142) and bare `ALPHA` (line-217) dispatch paths.
 * The post-fix assertion is that `process.cwd()` ends up at the canonical
 * `alpha` worktree path (silent graceful switch). Pre-fix the same call
 * lands in `handleCreate("ALPHA")` which fatal-errors out of `git worktree add`
 * — observable by an `error`-severity notify and `process.cwd()` unchanged
 * from the basePath.
 *
 * RED proof (pre-fix): revert either of the case-insensitive `.find()`
 * calls at `worktree-command.ts:142` or `:222` back to the strict
 * `existing.some(wt => wt.name === ...)` check; recompile; rerun. The
 * relevant subtest fails because `handleCreate` runs and either throws
 * (caught by handleCreate's catch) or successfully creates a separate
 * directory on case-sensitive fs. On macOS the catch fires and notify
 * receives an "error"-severity "Failed to create worktree" message.
 *
 * GREEN proof (post-fix): both call-sites silently route to
 * `handleSwitch(basePath, "alpha", ctx)` and process.cwd() ends inside
 * `<base>/.gsd/worktrees/alpha`. notify receives an "info"-severity
 * "Switched to worktree alpha" message — NOT the canonical-mismatched
 * "ALPHA" the user typed.
 *
 * Direct-import per MEM009/MEM011 — no barrel; relative `.ts` extensions.
 */

import { describe, test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, platform } from "node:os";
import { execSync } from "node:child_process";

import { handleWorktreeCommand } from "../worktree-command.ts";
import { createWorktree, listWorktrees } from "../worktree-manager.ts";
import {
  clearWorktreeOriginalCwd,
  setWorktreeOriginalCwd,
} from "../worktree-session-state.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────

function run(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" }).trim();
}

interface NotifyCall {
  message: string;
  severity: string;
}

interface FakeCtx {
  ui: {
    notify: (msg: string, severity?: string) => void;
    prompt: (...args: unknown[]) => Promise<string>;
    confirm: (...args: unknown[]) => Promise<boolean>;
  };
  notifyCalls: NotifyCall[];
}

function makeFakeCtx(): FakeCtx {
  const calls: NotifyCall[] = [];
  return {
    notifyCalls: calls,
    ui: {
      notify(message: string, severity = "info") {
        calls.push({ message, severity });
      },
      // Default to "no — do not keep existing milestones" so handleCreate's
      // showConfirm() resolves immediately if it ever runs (it should NOT
      // run in the GREEN path — graceful switch routes through handleSwitch).
      async prompt(): Promise<string> {
        return "n";
      },
      async confirm(): Promise<boolean> {
        return false;
      },
    },
  };
}

// Deliberately-stubbed pi extension API. `handleWorktreeCommand` only forwards
// `pi` through to inner handlers; the create/switch flows we exercise here do
// not register commands or call any pi method.
const fakePi = {} as unknown as Parameters<typeof handleWorktreeCommand>[2];

// ─── Test repo setup ──────────────────────────────────────────────────────

const repos: string[] = [];
let originalCwd: string;

function makeRepo(): string {
  // Resolve the realpath up-front because process.cwd() returns the realpath
  // (e.g. macOS /var/folders/... → /private/var/folders/...) — comparing
  // mkdtemp output against process.cwd() without realpath produces spurious
  // strict-equality failures.
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "gsd-wt-case-")));
  repos.push(repo);
  run("git init -b main", repo);
  run("git config user.email test@test.com", repo);
  run("git config user.name 'Pi Test'", repo);
  // .gsd/ directory exists so milestone audits don't trip
  mkdirSync(join(repo, ".gsd"), { recursive: true });
  writeFileSync(join(repo, "README.md"), "# case-collision-fixture\n", "utf-8");
  run("git add -A", repo);
  run('git commit -m init', repo);
  return repo;
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("worktree-command — case-insensitive collision (M003/S03/T02 Bug 2)", () => {
  before(() => {
    originalCwd = process.cwd();
  });

  after(() => {
    try { process.chdir(originalCwd); } catch { /* ignore */ }
    for (const r of repos) {
      try { rmSync(r, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  beforeEach(() => {
    clearWorktreeOriginalCwd();
  });

  afterEach(() => {
    // Restore cwd between tests so chdir-into-worktree from one test doesn't
    // poison the next.
    try { process.chdir(originalCwd); } catch { /* ignore */ }
    clearWorktreeOriginalCwd();
  });

  test("listWorktrees returns canonical-cased name after createWorktree('alpha')", () => {
    // Sanity check on the fixture itself, independent of the dispatch path.
    const base = makeRepo();
    process.chdir(base);
    const info = createWorktree(base, "alpha");
    assert.equal(info.name, "alpha");
    const list = listWorktrees(base);
    const alpha = list.find(w => w.name === "alpha");
    assert.ok(alpha, "expected 'alpha' in listWorktrees output");
    // Confirm fs is case-insensitive (test only meaningful on case-fold fs).
    if (platform() === "darwin" || platform() === "win32") {
      const altPath = join(base, ".gsd", "worktrees", "ALPHA");
      assert.ok(
        existsSync(altPath),
        "fixture precondition: case-insensitive fs should resolve ALPHA→alpha",
      );
    }
  });

  test("`switch ALPHA` (line-142 dispatch) routes silently to handleSwitch with canonical 'alpha'", async () => {
    const base = makeRepo();
    process.chdir(base);
    const info = createWorktree(base, "alpha");

    const ctx = makeFakeCtx();
    await handleWorktreeCommand("switch ALPHA", ctx as never, fakePi, "wt");

    // GREEN: handleSwitch ran → process.cwd() is now inside the alpha worktree.
    // (handleSwitch performs process.chdir(wtPath).)
    const cwdNow = process.cwd();
    assert.equal(
      cwdNow,
      info.path,
      `expected process.cwd() to be the canonical alpha worktree path; got ${cwdNow}`,
    );

    // No "error"-severity notify should have been emitted.
    const errors = ctx.notifyCalls.filter(c => c.severity === "error");
    assert.equal(
      errors.length,
      0,
      `expected zero error notifies; got: ${errors.map(e => e.message).join(" | ")}`,
    );

    // Notify message must reference the canonical name 'alpha', NOT the
    // user-typed 'ALPHA' — the silent-graceful-switch contract.
    const switchNote = ctx.notifyCalls.find(c => /Switched to worktree/i.test(c.message));
    assert.ok(switchNote, "expected a 'Switched to worktree' notify");
    assert.match(
      switchNote.message,
      /\balpha\b/,
      "expected switch notify to name the canonical 'alpha'",
    );
    assert.doesNotMatch(
      switchNote.message,
      /\bALPHA\b/,
      "switch notify must NOT echo the user-typed 'ALPHA' casing",
    );
  });

  test("bare `ALPHA` (line-217 dispatch) routes silently to handleSwitch with canonical 'alpha'", async () => {
    const base = makeRepo();
    process.chdir(base);
    const info = createWorktree(base, "alpha");

    const ctx = makeFakeCtx();
    await handleWorktreeCommand("ALPHA", ctx as never, fakePi, "wt");

    // GREEN: silent-graceful-switch → cwd at the canonical worktree.
    const cwdNow = process.cwd();
    assert.equal(
      cwdNow,
      info.path,
      `expected process.cwd() to be the canonical alpha worktree path; got ${cwdNow}`,
    );

    const errors = ctx.notifyCalls.filter(c => c.severity === "error");
    assert.equal(
      errors.length,
      0,
      `expected zero error notifies; got: ${errors.map(e => e.message).join(" | ")}`,
    );

    const switchNote = ctx.notifyCalls.find(c => /Switched to worktree/i.test(c.message));
    assert.ok(switchNote, "expected a 'Switched to worktree' notify on bare-name dispatch");
    assert.match(switchNote.message, /\balpha\b/);
    assert.doesNotMatch(switchNote.message, /\bALPHA\b/);
  });

  test("exact-case `switch alpha` still routes to handleSwitch (no regression)", async () => {
    const base = makeRepo();
    process.chdir(base);
    const info = createWorktree(base, "alpha");

    const ctx = makeFakeCtx();
    await handleWorktreeCommand("switch alpha", ctx as never, fakePi, "wt");

    assert.equal(process.cwd(), info.path);
    const errors = ctx.notifyCalls.filter(c => c.severity === "error");
    assert.equal(errors.length, 0);
  });

  test("non-collision name `beta` still routes to handleCreate (no regression)", async () => {
    const base = makeRepo();
    process.chdir(base);
    createWorktree(base, "alpha");

    const ctx = makeFakeCtx();
    // 'beta' has no collision with 'alpha' under any casing; this must
    // execute the create branch (we don't assert success of git worktree add
    // here — only that it does NOT silently land on the alpha worktree).
    await handleWorktreeCommand("beta", ctx as never, fakePi, "wt");

    const cwdNow = process.cwd();
    assert.notEqual(
      cwdNow,
      join(base, ".gsd", "worktrees", "alpha"),
      "non-collision name must NOT land on the alpha worktree",
    );
  });
});
