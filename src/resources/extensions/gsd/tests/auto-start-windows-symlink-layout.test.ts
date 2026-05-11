/**
 * auto-start-windows-symlink-layout.test.ts
 * — M002/S05/T03 D011 reproduce-or-downgrade gate test for the Windows
 *   `isUnderGsdWorktrees` regex in auto-start.ts.
 *
 * D011 verdict (recorded at execution time): HARDENING M002/S05 — pre-fix
 * theoretical only. The regex template `\\${pathSep}\\.gsd\\${pathSep}projects\\${pathSep}[a-f0-9]+\\${pathSep}worktrees(?:\\${pathSep}|$)`
 * produces the correct pattern on BOTH POSIX (pathSep='/') and Windows
 * (pathSep='\\') when the JS string-escape and RegExp constructor are
 * resolved together. RESEARCH §"Windows regex" leaned theoretical; this
 * test confirms by reconstructing the regex with both pathSep values
 * against synthetic paths.
 *
 * Bug shape (theoretical)
 *   The bug-list cites `auto-start.ts:836-839` Windows-only `isUnderGsdWorktrees`
 *   regex as a Windows-only failure. The hypothesis: under Windows pathSep
 *   the doubled-escape produces an over-escaped pattern that never matches
 *   real Windows paths.
 *
 *   Reality (verified by this test): on Windows, `\\${pathSep}` interpolates
 *   to a 3-char string `\\\` (two backslashes from the literal + one from
 *   the path separator). Passed to RegExp, `\\\.` becomes regex `\\.` which
 *   matches literal `\` followed by literal `.` — correct for Windows
 *   `\.gsd\projects\<hash>\worktrees` paths.
 *
 * Test shape (MEM060 source-guard hardening pattern, mirrors M002/S04/T01)
 *   (a) D011 BEHAVIOR PROBE       — reconstruct the regex template inline
 *                                   with BOTH pathSep='/' (POSIX) AND
 *                                   pathSep='\\' (Windows); test against
 *                                   synthetic Windows-style and POSIX-style
 *                                   paths; assert the regex matches
 *                                   correctly under both. If this subtest
 *                                   fails pre-fix → bug REPRODUCES → flip
 *                                   classification to [FIXED M002/S05] in
 *                                   T04. If it passes (it does) → lock
 *                                   [HARDENING M002/S05 — pre-fix theoretical only].
 *   (b) PRODUCTION SOURCE GUARD   — string-grep auto-start.ts for the
 *                                   regex template shape itself, so a
 *                                   future refactor that replaces the
 *                                   doubled-escape with an under-escaped
 *                                   variant fails the guard verbatim.
 *                                   This is the MEM060 D011 hardening
 *                                   pattern: the guard subtest IS the
 *                                   regression detector.
 *   (c) POSIX BEHAVIOR SANITY     — explicit subtest reaffirming the
 *                                   POSIX path matches its expected
 *                                   forms (direct + symlink-resolved
 *                                   layouts) so the macOS/Linux
 *                                   production path is regression-clean.
 *
 * R017 compliance: macOS/Linux fixture-only. No real Windows CI; the
 * Windows behavior is reconstructed from the production regex template
 * with a synthetic pathSep='\\'. Documented inline.
 *
 * R015 compliance: no new dependencies. node:test + node:fs only.
 *
 * MEM046 baseline: prefix CI runs with
 *   `env -u GSD_PROJECT_ROOT PATH="$PWD/node_modules/.bin:$PATH"`
 * to avoid worktree-resolver contamination.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const AUTO_START_SRC = (() => {
  const here = new URL(import.meta.url);
  const path = here.pathname;
  const idx = path.indexOf("/dist-test/");
  const repoRoot = idx !== -1 ? path.slice(0, idx) : process.cwd();
  return readFileSync(
    join(repoRoot, "src/resources/extensions/gsd/auto-start.ts"),
    "utf-8",
  );
})();

/**
 * Reconstructs the production isUnderGsdWorktrees logic for an arbitrary
 * pathSep value. This is the EXACT shape of the closure at
 * auto-start.ts:828-840 — same template literals, same RegExp call.
 */
function makeIsUnderGsdWorktrees(pathSep: string) {
  return (p: string): boolean => {
    const marker = `${pathSep}.gsd${pathSep}worktrees${pathSep}`;
    if (p.includes(marker)) return true;
    const worktreesSuffix = `${pathSep}.gsd${pathSep}worktrees`;
    if (p.endsWith(worktreesSuffix)) return true;
    const symlinkRe = new RegExp(
      `\\${pathSep}\\.gsd\\${pathSep}projects\\${pathSep}[a-f0-9]+\\${pathSep}worktrees(?:\\${pathSep}|$)`,
    );
    return symlinkRe.test(p);
  };
}

// ─── (a) D011 BEHAVIOR PROBE ─────────────────────────────────────────────────

test("M002/S05/T03 (a) — D011 BEHAVIOR PROBE: isUnderGsdWorktrees matches real Windows + POSIX paths under both pathSep values", () => {
  // ── Windows pathSep ──
  const isUnderWin = makeIsUnderGsdWorktrees("\\");

  // Direct Windows layout — should match via the marker `.includes`.
  assert.equal(
    isUnderWin("C:\\Users\\dev\\.gsd\\worktrees\\M001"),
    true,
    "Windows direct layout (under .gsd\\worktrees\\M001) must match",
  );

  // Symlink-resolved Windows layout — should match via the regex.
  assert.equal(
    isUnderWin("C:\\Users\\dev\\.gsd\\projects\\abc123def456\\worktrees\\M001"),
    true,
    "Windows symlink-resolved layout (under .gsd\\projects\\<hash>\\worktrees\\M001) must match — confirms the doubled-escape regex template works under Windows pathSep",
  );

  // Endpoint suffix Windows layout (no trailing slash) — should match via
  // the worktreesSuffix `.endsWith` OR the regex's `(?:\\${pathSep}|$)`.
  assert.equal(
    isUnderWin("C:\\Users\\dev\\.gsd\\projects\\abc123def456\\worktrees"),
    true,
    "Windows symlink-resolved endpoint (no trailing separator) must match",
  );

  // Negative — unrelated path.
  assert.equal(
    isUnderWin("C:\\Users\\dev\\my-project"),
    false,
    "Windows non-worktree path must NOT match",
  );

  // ── POSIX pathSep ──
  const isUnderPosix = makeIsUnderGsdWorktrees("/");

  assert.equal(
    isUnderPosix("/Users/dev/.gsd/worktrees/M001"),
    true,
    "POSIX direct layout must match",
  );
  assert.equal(
    isUnderPosix("/Users/dev/.gsd/projects/abc123def456/worktrees/M001"),
    true,
    "POSIX symlink-resolved layout must match",
  );
  assert.equal(
    isUnderPosix("/Users/dev/.gsd/projects/abc123def456/worktrees"),
    true,
    "POSIX symlink-resolved endpoint must match",
  );
  assert.equal(
    isUnderPosix("/Users/dev/my-project"),
    false,
    "POSIX non-worktree path must NOT match",
  );
});

// ─── (b) PRODUCTION SOURCE GUARD ─────────────────────────────────────────────

test("M002/S05/T03 (b) — PRODUCTION SOURCE GUARD: auto-start.ts contains the doubled-escape regex template (MEM060 hardening)", () => {
  // The regex template MUST appear verbatim in auto-start.ts. Any future
  // refactor that switches to an under-escaped variant (e.g.
  // `${pathSep}` instead of `\\${pathSep}`) fails the guard.
  assert.match(
    AUTO_START_SRC,
    /new RegExp\(\s*`\\\\\$\{pathSep\}\\\\\.gsd\\\\\$\{pathSep\}projects\\\\\$\{pathSep\}\[a-f0-9\]\+\\\\\$\{pathSep\}worktrees\(\?:\\\\\$\{pathSep\}\|\$\)`/,
    "auto-start.ts must contain the doubled-escape regex template `\\\\${pathSep}\\\\.gsd\\\\${pathSep}projects\\\\${pathSep}[a-f0-9]+\\\\${pathSep}worktrees(?:\\\\${pathSep}|$)` \u2014 the template that produces correct patterns under BOTH POSIX and Windows pathSep (M002/S05/T03 D011 hardening: pre-fix theoretical only)",
  );

  // The marker + worktreesSuffix templates are also required.
  assert.match(
    AUTO_START_SRC,
    /const marker = `\$\{pathSep\}\.gsd\$\{pathSep\}worktrees\$\{pathSep\}`/,
    "auto-start.ts must contain the marker template `${pathSep}.gsd${pathSep}worktrees${pathSep}`",
  );
  assert.match(
    AUTO_START_SRC,
    /const worktreesSuffix = `\$\{pathSep\}\.gsd\$\{pathSep\}worktrees`/,
    "auto-start.ts must contain the worktreesSuffix template `${pathSep}.gsd${pathSep}worktrees`",
  );
});

// ─── (c) POSIX BEHAVIOR SANITY ───────────────────────────────────────────────

test("M002/S05/T03 (c) — POSIX BEHAVIOR SANITY: production-shape paths under macOS/Linux match correctly (regression baseline for the existing CI environment)", () => {
  // This subtest reaffirms the CI environment's macOS/Linux behavior is
  // unaffected. The reconstruction matches the production closure's
  // shape exactly so this is the canonical assertion that nothing
  // regressed for the platform the CI actually runs on.
  const isUnder = makeIsUnderGsdWorktrees("/");

  // Real shapes from M002 itself (this very worktree) and similar.
  assert.equal(
    isUnder("/Users/mirogers/.gsd/projects/3377e01d370c/worktrees/M002"),
    true,
    "M002 worktree path must match (proves the symlink-resolved regex works under POSIX)",
  );
  assert.equal(
    isUnder("/var/folders/2z/y16p05n15mb45lmhr38d68kr0000gn/T/gsd-test-XYZ/.gsd/worktrees/M001"),
    true,
    "tmpdir test fixture worktree path must match (proves the marker .includes works under POSIX)",
  );
  assert.equal(
    isUnder("/Users/mirogers/src/github.com/mirogers-jha/gsd-2"),
    false,
    "regular project root (no worktree segment) must NOT match",
  );
});
