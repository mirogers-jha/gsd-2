// Project/App: GSD-2
// File Purpose: D004 reproduce-and-prevent test for M003/S04 Bug 3 — the
// `worktree-session-state.ts` module-global `originalCwd` slot caused
// confused-deputy cross-talk between concurrent `enterMilestone` calls,
// and the marker-match path was fragile vs CRLF / backslash / symlinked-
// external layouts.
//
// Sub-tests:
//   A — per-resolver registry isolation (last-registered wins)
//   B — AsyncLocalStorage parallel-await isolation
//   C — module-global fallback emits the legacy-caller warning
//   D — `normalizeCwdForMatching` shapes (backslash → slash, CRLF strip,
//       multi-LF strip, mixed paths, no-whitespace passthrough)
//   E — `realpathSync` symlinked-external fallback
//   F — backwards-compat: legacy `setWorktreeOriginalCwd` still allows
//       `getActiveWorktreeName` to recover from a worktree-internal cwd
//   G — D011 source-guard: module declares `_activeResolvers` and
//       exports `withWorktreeOriginalCwd` (HARDENING per-test classification
//       in SUMMARY: A/B/C/D/F = REPRO; E = REPRO; G = HARDENING).
//
// MEM035: `delete process.env.GSD_PROJECT_ROOT` in beforeEach so
//   downstream codepaths do not short-circuit through inherited env.
// MEM079: `realpathSync(mkdtempSync(...))` for symlinked /tmp on macOS.
// MEM013: this test only exercises the session-state module + node:fs;
//   no production deps that need worktree-root node_modules symlink.

import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _resetActiveResolversForTests,
  clearWorktreeOriginalCwd,
  ensureWorktreeOriginalCwdFromPath,
  getActiveWorktreeName,
  getWorktreeOriginalCwd,
  normalizeCwdForMatching,
  registerActiveResolver,
  setWorktreeOriginalCwd,
  unregisterActiveResolver,
  withWorktreeOriginalCwd,
  type ResolverLike,
} from "../worktree-session-state.js";
import { drainLogs, _resetLogs } from "../workflow-logger.js";

// ─── Lifecycle ──────────────────────────────────────────────────────────────

let savedProjectRoot: string | undefined;
beforeEach(() => {
  savedProjectRoot = process.env.GSD_PROJECT_ROOT;
  delete process.env.GSD_PROJECT_ROOT;
  _resetActiveResolversForTests();
  clearWorktreeOriginalCwd();
  _resetLogs();
});

function restoreEnv() {
  if (savedProjectRoot !== undefined) {
    process.env.GSD_PROJECT_ROOT = savedProjectRoot;
  }
}

function makeResolverLike(originalCwd: string | null = null): ResolverLike {
  return { s: { originalCwd } };
}

// ─── Sub-test A — per-resolver registry isolation ───────────────────────────

test("Bug3.A per-resolver registry: last-registered non-null wins; unregister falls back", () => {
  try {
    const A = makeResolverLike("/proj/A");
    const B = makeResolverLike("/proj/B");

    registerActiveResolver(A);
    assert.equal(getWorktreeOriginalCwd(), "/proj/A", "single resolver returns its slot");

    registerActiveResolver(B);
    // Hybrid resolver walks all registered resolvers and prefers the
    // most recently inserted non-null. Set iteration order = insertion order.
    assert.equal(
      getWorktreeOriginalCwd(),
      "/proj/B",
      "after registering B, last-registered slot wins",
    );

    unregisterActiveResolver(B);
    assert.equal(
      getWorktreeOriginalCwd(),
      "/proj/A",
      "unregistering B falls back to A's slot",
    );
  } finally {
    restoreEnv();
  }
});

// ─── Sub-test B — ALS context isolation across parallel awaits ──────────────

test("Bug3.B ALS isolation: parallel `withWorktreeOriginalCwd` chains return their own value", async () => {
  try {
    const yieldThenRead = async (): Promise<string | null> => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      return getWorktreeOriginalCwd();
    };

    const [a, b] = await Promise.all([
      withWorktreeOriginalCwd("/proj/X", yieldThenRead),
      withWorktreeOriginalCwd("/proj/Y", yieldThenRead),
    ]);

    assert.equal(a, "/proj/X", "ALS context X must propagate through await");
    assert.equal(b, "/proj/Y", "ALS context Y must propagate through await");
  } finally {
    restoreEnv();
  }
});

// ─── Sub-test C — module-global fallback emits legacy-caller warning ────────

test("Bug3.C module-global fallback returns the value AND emits a logWarning", () => {
  try {
    setWorktreeOriginalCwd("/legacy/proj");
    // _resetActiveResolversForTests() in beforeEach guarantees the registry
    // has no entries; with no ALS context the resolver hits tier-3.
    _resetLogs(); // discard the setter's no-op churn before measuring.
    const got = getWorktreeOriginalCwd();
    assert.equal(got, "/legacy/proj", "module-global fallback returns the set value");
    const warnings = drainLogs().filter(
      (e) => e.severity === "warn" && e.component === "worktree",
    );
    assert.ok(
      warnings.some((w) =>
        w.message.includes("module-global fallback (legacy caller)"),
      ),
      `expected legacy-caller warning, got: ${JSON.stringify(warnings)}`,
    );
  } finally {
    restoreEnv();
  }
});

// ─── Sub-test D — normalizer shapes ─────────────────────────────────────────

test("Bug3.D normalizeCwdForMatching handles backslash, CRLF, LF runs, mixed paths, passthrough", () => {
  // Backslash → slash
  assert.equal(
    normalizeCwdForMatching("C:\\proj\\.gsd\\worktrees\\M001\\sub"),
    "C:/proj/.gsd/worktrees/M001/sub",
    "backslash → slash conversion",
  );
  // CRLF tail strip
  assert.equal(
    normalizeCwdForMatching("/proj/sub\r\n"),
    "/proj/sub",
    "single CRLF tail strip",
  );
  // Multi-LF tail strip
  assert.equal(
    normalizeCwdForMatching("/proj/sub\n\n"),
    "/proj/sub",
    "multi-LF tail strip",
  );
  // Mixed: backslash + CRLF
  assert.equal(
    normalizeCwdForMatching("C:\\proj\\sub\r\n"),
    "C:/proj/sub",
    "mixed backslash + CRLF",
  );
  // No whitespace — passthrough
  assert.equal(
    normalizeCwdForMatching("/already/normal/path"),
    "/already/normal/path",
    "no-whitespace passthrough",
  );
  // Idempotent
  const once = normalizeCwdForMatching("C:\\proj\\sub\r\n");
  const twice = normalizeCwdForMatching(once);
  assert.equal(twice, once, "idempotent: double-application unchanged");
});

// ─── Sub-test E — realpathSync symlinked-external fallback ──────────────────

test("Bug3.E ensureWorktreeOriginalCwdFromPath falls back to realpath for symlinked-external layouts", () => {
  const dirs: string[] = [];
  try {
    // Build the symlinked-external layout:
    //   <real>/.gsd/worktrees/M001/sub          <-- realpath target
    //   <alias-parent>/wt-link  -> <real>/.gsd/worktrees/M001/sub
    const real = realpathSync(mkdtempSync(join(tmpdir(), "gsd-wts-real-")));
    dirs.push(real);
    const sub = join(real, ".gsd", "worktrees", "M001", "sub");
    mkdirSync(sub, { recursive: true });

    const aliasParent = realpathSync(mkdtempSync(join(tmpdir(), "gsd-wts-alias-")));
    dirs.push(aliasParent);
    const alias = join(aliasParent, "wt-link");
    symlinkSync(sub, alias, "dir");

    // Caller passes the symlinked path. Pre-fix: marker missing → null.
    // Post-fix: realpathSync uncovers `/.gsd/worktrees/` in the resolved path.
    const root = ensureWorktreeOriginalCwdFromPath(alias);
    assert.equal(root, real, "realpath fallback returns real project root");
    assert.equal(
      getWorktreeOriginalCwd(),
      real,
      "module-global is updated as side effect",
    );
  } finally {
    for (const d of dirs) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* noop */ }
    }
    restoreEnv();
  }
});

// ─── Sub-test F — backwards-compat: legacy setter + getActiveWorktreeName ──

test("Bug3.F legacy setWorktreeOriginalCwd flow recovers worktree name from a worktree-internal cwd", () => {
  const dirs: string[] = [];
  const savedCwd = process.cwd();
  try {
    const real = realpathSync(mkdtempSync(join(tmpdir(), "gsd-wts-legacy-")));
    dirs.push(real);
    const wtSub = join(real, ".gsd", "worktrees", "wt-foo", "deep", "sub");
    mkdirSync(wtSub, { recursive: true });

    setWorktreeOriginalCwd(real);
    process.chdir(wtSub);

    assert.equal(
      getActiveWorktreeName(),
      "wt-foo",
      "active worktree name is recovered from cwd inside the worktree",
    );
  } finally {
    try { process.chdir(savedCwd); } catch { /* noop */ }
    for (const d of dirs) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* noop */ }
    }
    restoreEnv();
  }
});

// ─── Sub-test G — D011 HARDENING source-guard ───────────────────────────────
//
// HARDENING (per D011): the cross-talk failure mode is observable by
// sub-test A and the parallel-await isolation by sub-test B; this guard
// pins the literal source-shape so a future refactor cannot silently
// regress the registry / ALS surface without breaking this assertion.
test("Bug3.G HARDENING source-guard: module declares _activeResolvers and exports withWorktreeOriginalCwd", () => {
  // Read TS source (not compiled JS) so the assertions match what humans
  // edit. Path is fixed relative to the test file's source location.
  const src = readFileSync(
    new URL("../worktree-session-state.ts", import.meta.url),
    "utf-8",
  );
  assert.match(
    src,
    /_activeResolvers\s*:\s*Set<ResolverLike>\s*=\s*new\s+Set\(\)/,
    "registry declaration must be present",
  );
  assert.match(
    src,
    /export\s+function\s+withWorktreeOriginalCwd</,
    "withWorktreeOriginalCwd must be exported",
  );
  assert.match(
    src,
    /AsyncLocalStorage<\{[^}]*originalCwd:\s*string\s*\|\s*null/,
    "ALS store must be typed for { originalCwd: string | null }",
  );
});
