/**
 * session-lock-toctou.test.ts — D004 reproduce-and-prevent for M003/S02 Bug 2.
 *
 * Bug: `session-lock.ts:308-316` (pre-flight stale cleanup) and
 * `session-lock.ts:349-372` (retry-after-fail cleanup) BOTH used the same
 * TOCTOU-vulnerable sequence:
 *
 *     if (existingPid is dead) { rmSync(lockDir); unlinkSync(lp); ... }
 *
 * Between the PID-dead check and the `rmSync` a fresh owner could win the
 * proper-lockfile claim and write its own `auto.lock` — the inline cleanup
 * would then stomp the fresh owner's metadata, leaving two processes that
 * each believed they owned the session lock.
 *
 * Fix: extract a `safeCleanupStaleLock(lockTarget, lp, lockfile)` helper that
 * does claim-then-validate (first PID check → O_EXCL claim → second PID check
 * → only-then wipe → release claim). Both callsites now consume the helper.
 *
 * Test strategy (D005 seam-driven, no concurrent processes): the
 * `_setLockfileForTests` seam plants a fake `lockSync` that, when the helper
 * takes its claim, simulates a fresh owner appearing — overwrites `auto.lock`
 * with a fresh PID and flips `_setIsPidAliveForTests` so the helper's second
 * check sees a live foreign PID. Pre-fix the inline cleanup runs anyway; post-
 * fix the second check rejects the cleanup attempt, the fresh `auto.lock`
 * survives, and `acquireSessionLock` returns `{ acquired: false, existingPid }`.
 *
 * Sub-cases:
 *   2a. Pre-flight cleanup TOCTOU (`session-lock.ts:308-316` site)
 *   2b. Retry-after-fail cleanup TOCTOU (`session-lock.ts:349-372` site)
 *   2c. Fallback path consumes EPERM-aware `isPidAlive`
 *      (`acquireFallbackLock` doesn't manage a `.lock/` dir → no TOCTOU; the
 *       assertion is "fallback correctly treats foreign-uid alive as alive").
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  acquireSessionLock,
  releaseSessionLock,
  safeCleanupStaleLock,
  _setLockfileForTests,
  _resetLockfileForTests,
  _setIsPidAliveForTests,
  _resetIsPidAliveForTests,
  effectiveLockTarget,
  type ProperLockfileApi,
  type SessionLockData,
} from "../session-lock.ts";
import { gsdRoot } from "../paths.ts";

// ─── Helpers ───────────────────────────────────────────────────────────────

interface PreparedFixture {
  base: string;
  gsdDir: string;
  lockTarget: string;
  lp: string;
  lockDir: string;
}

function prepareFixture(label: string): PreparedFixture {
  const base = mkdtempSync(join(tmpdir(), `gsd-toctou-${label}-`));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  const gsdDir = gsdRoot(base);
  const lockTarget = effectiveLockTarget(gsdDir);
  const lp = join(gsdDir, "auto.lock");
  const lockDir = lockTarget + ".lock";
  return { base, gsdDir, lockTarget, lp, lockDir };
}

function plantStaleLock(fix: PreparedFixture, stalePid: number): void {
  // The stale `.lock/` directory triggers the pre-flight cleanup branch.
  mkdirSync(fix.lockDir, { recursive: true });
  // The stale auto.lock metadata must contain a PID that the seam reports dead.
  const staleData: SessionLockData = {
    pid: stalePid,
    startedAt: new Date(Date.now() - 10_000).toISOString(),
    unitType: "starting",
    unitId: "bootstrap",
    unitStartedAt: new Date(Date.now() - 10_000).toISOString(),
  };
  writeFileSync(fix.lp, JSON.stringify(staleData, null, 2));
}

function readLockPid(lp: string): number | undefined {
  if (!existsSync(lp)) return undefined;
  try {
    return (JSON.parse(readFileSync(lp, "utf-8")) as SessionLockData).pid;
  } catch {
    return undefined;
  }
}

function cleanupFixture(fix: PreparedFixture): void {
  // Best-effort release in case a test left state behind.
  try { releaseSessionLock(fix.base); } catch { /* ignore */ }
  _resetLockfileForTests();
  _resetIsPidAliveForTests();
  rmSync(fix.base, { recursive: true, force: true });
}

/**
 * Build a fake lockfile API that simulates the TOCTOU race window.
 *
 * The fake intercepts `lockSync(target)` calls. The 1st invocation is the
 * helper's O_EXCL claim — between claim-take and the helper's second PID
 * check, the fake plants a fresh owner: writes `auto.lock` with `freshPid`
 * and flips the isPidAlive seam so freshPid reads as live.
 *
 * The 2nd invocation (production lockSync inside acquireSessionLock) throws
 * to simulate the fresh owner already holding the OS lock.
 */
function makeRaceLockfile(args: {
  lp: string;
  freshPid: number;
  // When true, on the FIRST lockSync call (helper's claim) plant the fresh owner
  injectOnFirstCall: boolean;
}): { api: ProperLockfileApi; calls: number; releases: number } {
  const state = { calls: 0, releases: 0 };
  const api: ProperLockfileApi = {
    lockSync(_path, _opts) {
      state.calls += 1;
      if (state.calls === 1 && args.injectOnFirstCall) {
        // The helper just took its O_EXCL claim. SIMULATE the fresh owner
        // appearing in this exact window: write fresh metadata + flip seam.
        const freshData: SessionLockData = {
          pid: args.freshPid,
          startedAt: new Date().toISOString(),
          unitType: "starting",
          unitId: "bootstrap",
          unitStartedAt: new Date().toISOString(),
        };
        writeFileSync(args.lp, JSON.stringify(freshData, null, 2));
        _setIsPidAliveForTests((pid) => pid === args.freshPid);
        // Return a release function that records release count.
        return () => { state.releases += 1; };
      }
      // Subsequent calls (production lockSync) throw — fresh owner holds it.
      throw new Error("ELOCKED: fake — lock target held by fresh owner");
    },
  };
  return Object.assign(state, { api });
}

// ─── Tests ─────────────────────────────────────────────────────────────────

test("2a. pre-flight cleanup TOCTOU: helper rejects fresh owner; fresh auto.lock survives; acquire reports freshPid", () => {
  const fix = prepareFixture("preflight");
  try {
    const stalePid = 99001;
    const freshPid = 88001;
    plantStaleLock(fix, stalePid);

    // Initial isPidAlive: stalePid is DEAD → triggers cleanup branch.
    _setIsPidAliveForTests((pid) => pid === stalePid ? false : false);

    const fake = makeRaceLockfile({ lp: fix.lp, freshPid, injectOnFirstCall: true });
    _setLockfileForTests(fake.api);

    const result = acquireSessionLock(fix.base);

    // Post-fix assertions:
    // 1. Acquire failed because the fresh owner won the race.
    assert.equal(result.acquired, false, "post-fix: acquire must fail when fresh owner won the race");
    if (!result.acquired) {
      assert.equal(result.existingPid, freshPid,
        `post-fix: existingPid in failure result must surface the fresh owner's PID (got ${result.existingPid})`);
      assert.match(result.reason, new RegExp(String(freshPid)),
        "post-fix: actionable message must mention the fresh owner's PID");
    }
    // 2. The fresh `auto.lock` planted mid-race MUST NOT have been stomped.
    assert.equal(readLockPid(fix.lp), freshPid,
      "post-fix: fresh auto.lock metadata planted by the race must still be on disk (not stomped by cleanup)");
    // 3. The helper took ONE claim and released it before the production lockSync attempt.
    assert.ok(fake.calls >= 2, "fake.lockSync called for both helper claim and production attempt");
    assert.equal(fake.releases, 1, "helper claim released exactly once before returning");
  } finally {
    cleanupFixture(fix);
  }
});

test("2b. retry-after-fail cleanup TOCTOU: helper rejects fresh owner; fresh auto.lock survives; falls through to actionable error", () => {
  const fix = prepareFixture("retry");
  try {
    const stalePid = 99002;
    const freshPid = 88002;
    plantStaleLock(fix, stalePid);

    // The retry-after-fail site is ENTERED only when the production lockSync
    // throws first AND the existing PID is dead. We achieve that by:
    //   - Pre-flight cleanup: helper called once. Fake's first call is the
    //     pre-flight helper's claim — but we DO NOT inject yet (let the
    //     pre-flight succeed cleanly, wiping the planted stale state).
    //   - Production lockSync (call #2): throws → catch arm.
    //   - Catch arm reads existingData: now there IS no auto.lock (helper
    //     wiped it). Re-plant stale data + lockDir, then make the next
    //     helper call (call #3) inject the race.
    //
    // Simpler approach: drive the catch arm directly by having the FIRST
    // production lockSync throw, then the cleanup helper's claim (call #2)
    // injects the fresh owner.

    // To force pre-flight cleanup to NOT run (so call #1 IS the production
    // lockSync), remove the planted .lock/ dir AFTER planting auto.lock.
    rmSync(fix.lockDir, { recursive: true, force: true });

    // Now: pre-flight `existsSync(lockDir)` is false → skip cleanup → go
    // straight to production lockSync. Fake call #1 throws → catch arm.
    // Catch arm sees existingData (stale), stalePid is dead → invokes
    // safeCleanupStaleLock. Fake call #2 is the helper's claim — INJECT.

    let callCount = 0;
    const releases = { count: 0 };
    const fakeApi: ProperLockfileApi = {
      lockSync(_path, _opts) {
        callCount += 1;
        if (callCount === 1) {
          // Production lockSync attempt — fail it to enter the catch arm.
          throw new Error("ELOCKED: fake call #1 — initial production attempt");
        }
        if (callCount === 2) {
          // Helper's O_EXCL claim — inject the fresh owner here.
          const freshData: SessionLockData = {
            pid: freshPid,
            startedAt: new Date().toISOString(),
            unitType: "starting",
            unitId: "bootstrap",
            unitStartedAt: new Date().toISOString(),
          };
          writeFileSync(fix.lp, JSON.stringify(freshData, null, 2));
          _setIsPidAliveForTests((pid) => pid === freshPid);
          return () => { releases.count += 1; };
        }
        // Any further call (post-cleanup retry that we should NOT take) throws.
        throw new Error("ELOCKED: unexpected post-cleanup retry — fix should not auto-retry on ok:false");
      },
    };

    _setIsPidAliveForTests((_pid) => false); // initially everyone is dead
    _setLockfileForTests(fakeApi);

    const result = acquireSessionLock(fix.base);

    // Post-fix assertions:
    assert.equal(result.acquired, false, "post-fix: acquire must fail in the retry-after-fail TOCTOU scenario");
    if (!result.acquired) {
      assert.equal(result.existingPid, freshPid,
        `post-fix: existingPid must surface the fresh owner's PID after retry-arm cleanup rejection (got ${result.existingPid})`);
      assert.match(result.reason, new RegExp(String(freshPid)),
        "post-fix: actionable message must mention the fresh owner's PID");
    }
    assert.equal(readLockPid(fix.lp), freshPid,
      "post-fix: fresh auto.lock metadata planted by the race must still be on disk");
    // Critical: the test's fake throws on call #3 — if the fix incorrectly
    // auto-retries lockSync after `ok: false`, the test would surface the
    // unexpected-retry error instead of returning acquired:false cleanly.
    assert.equal(callCount, 2,
      `production must NOT auto-retry lockSync after safeCleanupStaleLock returns ok:false (got ${callCount} calls)`);
    assert.equal(releases.count, 1, "helper claim released exactly once");
  } finally {
    cleanupFixture(fix);
  }
});

test("2c. fallback path: when proper-lockfile is unavailable, foreign-uid alive (EPERM) PID is honored — fallback returns acquired:false", () => {
  const fix = prepareFixture("fallback");
  try {
    const foreignAlivePid = 77777;
    // Plant existing lock metadata only (no .lock/ dir — fallback doesn't manage one).
    rmSync(fix.lockDir, { recursive: true, force: true });
    plantStaleLock(fix, foreignAlivePid);
    rmSync(fix.lockDir, { recursive: true, force: true });

    // Force the proper-lockfile resolution to fail → routes to acquireFallbackLock.
    _setLockfileForTests("unavailable");

    // EPERM-aware behavior: the foreign-uid PID reads as ALIVE via the seam.
    // (In production this is the actual `_defaultIsPidAlive` returning true on
    // EPERM. The seam injection here proves the fallback consumes the same
    // EPERM-aware path rather than wrongly treating EPERM as dead.)
    _setIsPidAliveForTests((pid) => pid === foreignAlivePid);

    const result = acquireSessionLock(fix.base);

    assert.equal(result.acquired, false,
      "fallback must refuse to acquire when an existing lock has an alive PID (EPERM-true semantics)");
    if (!result.acquired) {
      assert.equal(result.existingPid, foreignAlivePid,
        `fallback must surface the foreign-uid PID (got ${result.existingPid})`);
    }
    // The metadata file must NOT have been stomped (no auto-takeover).
    assert.equal(readLockPid(fix.lp), foreignAlivePid,
      "fallback must not overwrite an alive foreign-uid PID's lock metadata");
  } finally {
    cleanupFixture(fix);
  }
});

test("safeCleanupStaleLock: fast-path — first PID check sees alive owner → ok:false without taking claim", () => {
  const fix = prepareFixture("fast-path");
  try {
    const alivePid = 66666;
    plantStaleLock(fix, alivePid);
    // Owner reports alive on first check — helper must short-circuit.
    _setIsPidAliveForTests((pid) => pid === alivePid);

    let callCount = 0;
    const fakeApi: ProperLockfileApi = {
      lockSync(_path, _opts) {
        callCount += 1;
        return () => {};
      },
    };

    const result = safeCleanupStaleLock(fix.lockTarget, fix.lp, fakeApi);

    assert.equal(result.ok, false, "fast-path: first check returns ok:false");
    if (result.ok === false) {
      assert.equal(result.existingPid, alivePid);
    }
    assert.equal(callCount, 0, "first-check fast path must NOT take a lockfile claim");
    // Stale metadata preserved (we did NOT wipe it).
    assert.equal(readLockPid(fix.lp), alivePid, "stale auto.lock preserved on fast-path reject");
  } finally {
    cleanupFixture(fix);
  }
});

test("safeCleanupStaleLock: happy path — both checks pass, lockDir + auto.lock wiped, claim released", () => {
  const fix = prepareFixture("happy");
  try {
    const deadPid = 55555;
    plantStaleLock(fix, deadPid);
    // Both checks see dead.
    _setIsPidAliveForTests(() => false);

    const releases = { count: 0 };
    const fakeApi: ProperLockfileApi = {
      lockSync(_path, _opts) {
        // No injection — second check will see the same stale data.
        return () => { releases.count += 1; };
      },
    };

    const result = safeCleanupStaleLock(fix.lockTarget, fix.lp, fakeApi);

    assert.equal(result.ok, true, "happy path: cleanup succeeds when no fresh owner appears");
    assert.equal(existsSync(fix.lockDir), false, ".lock/ directory wiped");
    assert.equal(existsSync(fix.lp), false, "auto.lock unlinked");
    assert.equal(releases.count, 1, "claim released exactly once");
  } finally {
    cleanupFixture(fix);
  }
});
