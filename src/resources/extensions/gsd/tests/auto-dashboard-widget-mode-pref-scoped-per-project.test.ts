/**
 * auto-dashboard-widget-mode-pref-scoped-per-project.test.ts
 * — M002/S05/T01 D004 + smoke test for the cross-project widget-mode pref
 *   leak fix in auto-dashboard.ts.
 *
 * D011 verdict (S05-CONTEXT): REPRODUCES — pre-fix the
 * `widgetModePreferencePath` module-level cache was populated on first
 * `ensureWidgetModeLoaded()` call against whichever `process.cwd()` was
 * active then, and never re-resolved. With cmux/multi-project workflows,
 * subsequent toggles in OTHER projects wrote back to the FIRST project's
 * pref file (silent cross-project leak).
 *
 * Bug shape
 *   Pre-fix code shape:
 *     let widgetModePreferencePath: string | null = null;
 *     function ensureWidgetModeLoaded(...) {
 *       if (widgetModeInitialized) return;
 *       widgetModeInitialized = true;
 *       ...
 *       widgetModePreferencePath = resolveWidgetModePreferencePath(...);  // ← cached
 *     }
 *     function persistWidgetMode(mode, prefsPath = widgetModePreferencePath ?? resolveWidgetModePreferencePath()) {
 *       writeFileSync(prefsPath, ...);
 *     }
 *     export function setWidgetMode(mode, ...) {
 *       ...
 *       persistWidgetMode(widgetMode, widgetModePreferencePath ?? resolveWidgetModePreferencePath(...));
 *     }
 *
 *   Post-fix code shape:
 *     let widgetMode: WidgetMode = "full";
 *     let widgetModeInitialized = false;
 *     // (cache removed)
 *     function persistWidgetMode(mode, prefsPath = resolveWidgetModePreferencePath()) {
 *       ...
 *     }
 *     export function setWidgetMode(mode, ...) {
 *       ...
 *       persistWidgetMode(widgetMode, resolveWidgetModePreferencePath(...));  // ← fresh every call
 *     }
 *
 * Test shape (MEM058 paired-subtest D004 + MEM060 source guard)
 *   (a) PRE-FIX REPRO subtest     — replicate the buggy module-level-cache
 *                                   shape inline in a closure: bind a path
 *                                   on first call, then keep returning it
 *                                   on subsequent calls even when the
 *                                   "active project" has changed.
 *   (b) POST-FIX subtest          — exercise the production
 *                                   setWidgetMode/getWidgetMode against
 *                                   two tmpdirs (project A and project B):
 *                                   pass each project's pref path
 *                                   explicitly so the test bypasses cwd
 *                                   detection. Toggle in A → assert A
 *                                   pref file got the value. Toggle in B
 *                                   → assert B pref file got the value
 *                                   AND A's pref file is UNCHANGED. Then
 *                                   re-toggle in A → assert A pref file
 *                                   got the new value AND B's pref file
 *                                   is UNCHANGED. Cross-project isolation
 *                                   proved at the file-write boundary.
 *   (c) PRODUCTION SOURCE GUARD   — string-grep auto-dashboard.ts for the
 *                                   M002/S05/T01 marker comment AND the
 *                                   negative regex that the
 *                                   `widgetModePreferencePath` module-
 *                                   level `let` is GONE.
 *
 * R015 compliance: no new dependencies. node:test + node:fs only.
 *
 * MEM046 baseline: prefix CI runs with
 *   `env -u GSD_PROJECT_ROOT PATH="$PWD/node_modules/.bin:$PATH"`
 * to avoid worktree-resolver contamination.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  setWidgetMode,
  getWidgetMode,
  _resetWidgetModeForTests,
} from "../auto-dashboard.ts";

const DASHBOARD_SRC = (() => {
  const here = new URL(import.meta.url);
  const path = here.pathname;
  const idx = path.indexOf("/dist-test/");
  const repoRoot = idx !== -1 ? path.slice(0, idx) : process.cwd();
  return readFileSync(
    join(repoRoot, "src/resources/extensions/gsd/auto-dashboard.ts"),
    "utf-8",
  );
})();

function makeProjectDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `gsd-t01-${prefix}-`));
  mkdirSync(join(dir, ".gsd"), { recursive: true });
  // Pre-create an empty PREFERENCES.md so resolveWidgetModePreferencePath
  // picks this project's path (existence-only fallback at step 3 of the
  // resolver) instead of falling back to the global pref path.
  writeFileSync(join(dir, ".gsd", "PREFERENCES.md"), "", "utf-8");
  return dir;
}

function projectPrefsPath(projectDir: string): string {
  return join(projectDir, ".gsd", "PREFERENCES.md");
}

function readWidgetModeLine(prefsPath: string): string | null {
  if (!existsSync(prefsPath)) return null;
  const content = readFileSync(prefsPath, "utf-8");
  const m = content.match(/^widget_mode:\s*(\S+)/m);
  return m ? m[1]! : null;
}

// ─── (a) PRE-FIX REPRO ───────────────────────────────────────────────────────

test("M002/S05/T01 (a) — PRE-FIX REPRO: module-level-cache shape locks the pref path to the first project loaded", () => {
  // Replicate the buggy shape in a closure: cache the pref path on first
  // call, never re-resolve. This is exactly what the pre-fix code did at
  // the auto-dashboard.ts module scope with `widgetModePreferencePath`.
  let cachedPath: string | null = null;
  const buggyResolve = (currentProjectPath: string): string => {
    // Pre-fix shape: cache on first call, return cached forever.
    if (cachedPath === null) {
      cachedPath = currentProjectPath;
    }
    return cachedPath;
  };

  const projectA = "/tmp/projectA/.gsd/PREFERENCES.md";
  const projectB = "/tmp/projectB/.gsd/PREFERENCES.md";

  // First call binds to project A.
  assert.equal(buggyResolve(projectA), projectA, "first call binds to projectA");

  // SECOND call — the active project is now B, but the buggy resolver
  // still returns A. THIS IS THE BUG.
  assert.equal(
    buggyResolve(projectB),
    projectA,
    "pre-fix BUG: second call from projectB still returns projectA's path — cross-project leak",
  );

  // Even if we explicitly pass project B's path, the cache wins.
  assert.equal(
    buggyResolve(projectB),
    projectA,
    "pre-fix BUG: persistent module-level cache makes B's writes silently land in A's pref file",
  );
});

// ─── (b) POST-FIX ────────────────────────────────────────────────────────────

test("M002/S05/T01 (b) — POST-FIX: setWidgetMode against two project dirs writes each project's pref to ITS OWN file (no cross-project leak)", (t) => {
  const projectA = makeProjectDir("projA");
  const projectB = makeProjectDir("projB");
  const prefsA = projectPrefsPath(projectA);
  const prefsB = projectPrefsPath(projectB);

  t.after(() => {
    _resetWidgetModeForTests();
    rmSync(projectA, { recursive: true, force: true });
    rmSync(projectB, { recursive: true, force: true });
  });

  _resetWidgetModeForTests();

  // ── Step 1: toggle to "min" in project A ──
  // Pass projectPath/globalPath explicitly so the test bypasses cwd detection.
  setWidgetMode("min", prefsA, prefsA);
  assert.equal(getWidgetMode(prefsA, prefsA), "min", "in-memory mode reflects A's toggle");
  assert.equal(readWidgetModeLine(prefsA), "min", "post-fix: A's pref file has the value");
  assert.equal(readWidgetModeLine(prefsB), null, "post-fix: B's pref file is UNTOUCHED");

  // ── Step 2: toggle to "small" in project B ──
  // Pre-fix BUG: this would have re-used the cached A path and stomped A.
  // Post-fix: each call resolves fresh, so B writes to B.
  setWidgetMode("small", prefsB, prefsB);
  assert.equal(getWidgetMode(prefsB, prefsB), "small", "in-memory mode reflects B's toggle");
  assert.equal(readWidgetModeLine(prefsB), "small", "post-fix: B's pref file has the value");
  assert.equal(
    readWidgetModeLine(prefsA),
    "min",
    "post-fix CRITICAL: A's pref file is UNCHANGED after B's toggle (cross-project isolation enforced)",
  );

  // ── Step 3: toggle back to "full" in project A ──
  setWidgetMode("full", prefsA, prefsA);
  assert.equal(readWidgetModeLine(prefsA), "full", "post-fix: A's pref file has the new value");
  assert.equal(
    readWidgetModeLine(prefsB),
    "small",
    "post-fix CRITICAL: B's pref file is UNCHANGED after A's re-toggle (cross-project isolation enforced both directions)",
  );
});

// ─── (c) PRODUCTION SOURCE GUARD ─────────────────────────────────────────────

test("M002/S05/T01 (c) — PRODUCTION SOURCE GUARD: auto-dashboard.ts dropped the widgetModePreferencePath module-level cache", () => {
  // Marker comment.
  assert.match(
    DASHBOARD_SRC,
    /M002\/S05\/T01 — widgetModePreferencePath module-level cache REMOVED/,
    "auto-dashboard.ts must contain the M002/S05/T01 marker comment documenting the cache removal",
  );

  // Negative guard — the module-level `let widgetModePreferencePath:
  // string | null = null;` declaration MUST NOT appear. Strip
  // doc-comment lines first so the marker comment that itself names the
  // pattern doesn't false-positive.
  const codeOnly = DASHBOARD_SRC
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
  const moduleLevelCacheRe = /^let widgetModePreferencePath\s*:/m;
  assert.ok(
    !moduleLevelCacheRe.test(codeOnly),
    "auto-dashboard.ts must NOT declare `let widgetModePreferencePath: string | null = null;` at module scope — that was the M002/S05/T01 cross-project leak",
  );

  // persistWidgetMode default param resolves fresh — must NOT contain
  // the buggy `widgetModePreferencePath ?? resolveWidgetModePreferencePath()`
  // shape that fell back to the module-level cache.
  const buggyDefaultRe = /widgetModePreferencePath\s*\?\?\s*resolveWidgetModePreferencePath/;
  assert.ok(
    !buggyDefaultRe.test(codeOnly),
    "auto-dashboard.ts must NOT use `widgetModePreferencePath ?? resolveWidgetModePreferencePath(...)` anywhere — every call must resolve fresh",
  );

  // Sanity: persistWidgetMode default param IS `resolveWidgetModePreferencePath()`
  // (called fresh).
  assert.match(
    DASHBOARD_SRC,
    /prefsPath = resolveWidgetModePreferencePath\(\)/,
    "auto-dashboard.ts must default persistWidgetMode's prefsPath to a fresh `resolveWidgetModePreferencePath()` call",
  );
});

// ─── helper used in the post-fix subtest's UATesque side-flow ──
// (Bypass: the projectPath/globalPath signature is the canonical way to
// skip the cwd-detection path. We don't need a separate seam.)
void writeFileSync;
