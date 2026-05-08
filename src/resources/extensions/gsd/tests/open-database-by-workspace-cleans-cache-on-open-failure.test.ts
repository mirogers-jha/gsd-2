// GSD-2 + M001 S05 T05 (D004): regression test for openDatabaseByWorkspace
// cache-cleanup TOCTOU bug.
//
// The bug: between the initial `_dbCache.get(key)` (line 466) and the
// `_activeOpenDatabase(dbPath)` call (line 512), a concurrent open in
// another caller could race a stale half-state entry into the cache
// under `key`. Pre-fix, both failure branches (catch + !opened) restored
// globals but did NOT defensively `_dbCache.delete(key)`, leaving the
// stale entry visible to the next caller — which would treat it as a
// cache hit and reactivate a half-state adapter.
//
// The fix: route the open through `_activeOpenDatabase` (test seam,
// MEM007/MEM011) and defensively `_dbCache.delete(key)` + log
// `'open-failure cache cleanup'` on both failure branches.
//
// To deterministically reproduce the race (per D005 — race-bug repros use
// seam injection), the failing seam uses `_setDbCacheEntryForTests` to
// plant a stale entry under the new key just before throwing/returning
// false. Pre-fix that stale entry survives. Post-fix the defensive
// `_dbCache.delete(key)` evicts it.
//
// Two sub-tests, one per failure branch:
//   1. throw branch  — seam plants stale entry then throws
//   2. !opened branch — seam plants stale entry then returns false

import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createWorkspace } from "../workspace.ts";
import {
  openDatabaseByWorkspace,
  closeAllDatabases,
  _getDbCache,
  _getAdapter,
  _setOpenDatabaseForTests,
  _setDbCacheEntryForTests,
} from "../gsd-db.ts";
import type { DbAdapter } from "../db-adapter.ts";
import {
  _resetLogs,
  peekLogs,
  setStderrLoggingEnabled,
} from "../workflow-logger.ts";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeProjectDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  // hasGsdBootstrapArtifacts checks for .gsd/milestones or .gsd/PREFERENCES.md
  mkdirSync(join(dir, ".gsd", "milestones"), { recursive: true });
  return dir;
}

/**
 * Build a sentinel "stale" cache entry. Pre-fix, this object would survive
 * in `_dbCache` past a failing open and poison the next get() call. We use
 * a plain object cast to DbAdapter — it never gets exec()'d in this test;
 * we only check identity equality and presence/absence in the cache.
 */
function makeStaleSentinel(): { dbPath: string; db: DbAdapter; tag: string } {
  return {
    dbPath: "/sentinel/path",
    db: { tag: "stale-sentinel" } as unknown as DbAdapter,
    tag: "stale-sentinel",
  };
}

// ─── Suite ───────────────────────────────────────────────────────────────────

describe("openDatabaseByWorkspace: cache-cleanup on open failure (D004 regression)", () => {
  let projectA: string;
  let projectB: string;
  let prevStderrEnabled = true;

  beforeEach(() => {
    projectA = makeProjectDir("gsd-db-open-fail-A-");
    projectB = makeProjectDir("gsd-db-open-fail-B-");
    prevStderrEnabled = setStderrLoggingEnabled(false);
    _resetLogs();
  });

  afterEach(() => {
    // Always restore the seam so other tests are not affected.
    _setOpenDatabaseForTests(null);
    closeAllDatabases();
    rmSync(projectA, { recursive: true, force: true });
    rmSync(projectB, { recursive: true, force: true });
    setStderrLoggingEnabled(prevStderrEnabled);
  });

  test("throw branch: failing open evicts the stale entry concurrently planted under the new key", () => {
    const wsA = createWorkspace(projectA);
    const wsB = createWorkspace(projectB);
    assert.notEqual(wsA.identityKey, wsB.identityKey, "precondition: distinct identity keys");

    // 1. Open A normally.
    const okA = openDatabaseByWorkspace(wsA);
    assert.ok(okA, "first open of A should succeed");
    const adapterA = _getAdapter();
    assert.ok(adapterA, "A adapter live");

    // 2. Install seam that simulates the race: plant a stale entry under
    //    B's key (as if a concurrent worker had raced one in), then throw.
    const stale = makeStaleSentinel();
    const seamErr = new Error("seam: open failed");
    _setOpenDatabaseForTests(() => {
      _setDbCacheEntryForTests(wsB.identityKey, stale);
      throw seamErr;
    });

    // 3. Attempt to open B — must re-throw the seam error.
    assert.throws(
      () => openDatabaseByWorkspace(wsB),
      (err: unknown) => err === seamErr,
      "openDatabaseByWorkspace must re-throw the seam error verbatim",
    );

    // 4a. The stale entry under B's key MUST be gone (TOCTOU bug fix).
    //     Pre-fix this assertion fails — `stale` survives in _dbCache.
    assert.equal(
      _getDbCache().get(wsB.identityKey),
      undefined,
      "stale cache entry under failing new key (B) must be evicted by defensive delete",
    );

    // 4b. A's entry preserved and live.
    const cachedA = _getDbCache().get(wsA.identityKey);
    assert.ok(cachedA, "A's cache entry preserved");
    assert.equal(cachedA?.db, adapterA, "A's cached adapter is the same live instance");

    // 4c. Globals restored to A.
    assert.equal(_getAdapter(), adapterA, "currentDb restored to A's adapter");

    // 5. Observability: cleanup warning fired exactly once with B's key.
    const cleanupLogs = peekLogs().filter(
      (e) =>
        e.severity === "warn" &&
        e.component === "db" &&
        typeof e.message === "string" &&
        e.message.includes("open-failure cache cleanup"),
    );
    assert.equal(cleanupLogs.length, 1, "exactly one cleanup warning fired");
    assert.equal(
      (cleanupLogs[0]?.context as { key?: string } | undefined)?.key,
      wsB.identityKey,
      "warning context.key matches the failing new key",
    );
  });

  test("!opened branch: failing open (returns false) evicts the stale entry under the new key", () => {
    const wsA = createWorkspace(projectA);
    const wsB = createWorkspace(projectB);

    // 1. Open A normally.
    const okA = openDatabaseByWorkspace(wsA);
    assert.ok(okA, "first open of A should succeed");
    const adapterA = _getAdapter();
    assert.ok(adapterA, "A adapter live");

    // 2. Install seam: plant stale entry then return false (open declined).
    const stale = makeStaleSentinel();
    _setOpenDatabaseForTests(() => {
      _setDbCacheEntryForTests(wsB.identityKey, stale);
      return false;
    });

    // 3. Attempt to open B — must return false (no throw).
    const okB = openDatabaseByWorkspace(wsB);
    assert.equal(okB, false, "open of B returns false when seam declines");

    // 4a. Stale entry MUST be evicted.
    assert.equal(
      _getDbCache().get(wsB.identityKey),
      undefined,
      "stale cache entry under failing new key (B) must be evicted by defensive delete",
    );

    // 4b. A preserved.
    const cachedA = _getDbCache().get(wsA.identityKey);
    assert.ok(cachedA, "A's cache entry preserved");
    assert.equal(cachedA?.db, adapterA, "A's cached adapter is the same live instance");

    // 4c. Globals restored to A.
    assert.equal(_getAdapter(), adapterA, "currentDb restored to A's adapter");

    // 5. Cleanup warning fired exactly once.
    const cleanupLogs = peekLogs().filter(
      (e) =>
        e.severity === "warn" &&
        e.component === "db" &&
        typeof e.message === "string" &&
        e.message.includes("open-failure cache cleanup"),
    );
    assert.equal(cleanupLogs.length, 1, "exactly one cleanup warning fired");
    assert.equal(
      (cleanupLogs[0]?.context as { key?: string } | undefined)?.key,
      wsB.identityKey,
      "warning context.key matches the failing new key",
    );
  });

  test("seam reset: passing null to _setOpenDatabaseForTests restores the default opener", () => {
    const wsA = createWorkspace(projectA);

    _setOpenDatabaseForTests(() => false);
    assert.equal(openDatabaseByWorkspace(wsA), false, "failing seam → false");

    _setOpenDatabaseForTests(null);

    assert.ok(
      openDatabaseByWorkspace(wsA),
      "after _setOpenDatabaseForTests(null), default opener is restored",
    );
  });
});
