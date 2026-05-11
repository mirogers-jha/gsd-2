/**
 * GSD Session Lock — OS-level exclusive locking for auto-mode sessions.
 *
 * Prevents multiple GSD processes from running auto-mode concurrently on
 * the same project. Uses proper-lockfile for OS-level file locking (flock/
 * lockfile) which eliminates the TOCTOU race condition that existed with
 * the old advisory JSON lock approach.
 *
 * The lock file (.gsd/auto.lock) contains JSON metadata (PID, start time,
 * unit info) for diagnostics, but the actual exclusion is enforced by the
 * OS-level lock held via proper-lockfile.
 *
 * Lifecycle:
 *   acquireSessionLock()  — called at the START of bootstrapAutoSession
 *   validateSessionLock() — called periodically during dispatch to detect takeover
 *   releaseSessionLock()  — called on clean stop/pause
 */

import { createRequire } from "node:module";
import { existsSync, readFileSync, readdirSync, mkdirSync, unlinkSync, rmSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { gsdRoot } from "./paths.js";
import { atomicWriteSync } from "./atomic-write.js";

const _require = createRequire(import.meta.url);

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SessionLockData {
  pid: number;
  startedAt: string;
  unitType: string;
  unitId: string;
  unitStartedAt: string;
  sessionFile?: string;
}

export type SessionLockResult =
  | { acquired: true }
  | { acquired: false; reason: string; existingPid?: number };

export type SessionLockFailureReason =
  | "compromised"
  | "missing-metadata"
  | "pid-mismatch";

export interface SessionLockStatus {
  valid: boolean;
  failureReason?: SessionLockFailureReason;
  existingPid?: number;
  expectedPid?: number;
  recovered?: boolean;
}

export interface ProperLockfileApi {
  lockSync(
    path: string,
    options?: {
      realpath?: boolean;
      stale?: number;
      update?: number;
      onCompromised?: () => void;
    },
  ): () => void;
}

// ─── Module State ───────────────────────────────────────────────────────────

/** Release function from proper-lockfile — calling it releases the OS lock. */
let _releaseFunction: (() => void) | null = null;

/** The path we currently hold a lock on. */
let _lockedPath: string | null = null;

/** Our PID at lock acquisition time. */
let _lockPid: number = 0;

/** Set to true when proper-lockfile fires onCompromised (mtime drift, sleep, etc.). */
let _lockCompromised: boolean = false;

/** Whether we've already registered a process.on('exit') handler. */
let _exitHandlerRegistered: boolean = false;

/** Registry of all gsdDir paths where locks were created during this session.
 *  The exit handler cleans ALL of these, not just the current gsdRoot(). (#1578) */
const _lockDirRegistry: Set<string> = new Set();

/** Snapshotted lock file path — captured at acquireSessionLock time to avoid
 *  gsdRoot() resolving differently in worktree vs project root contexts (#1363). */
let _snapshotLockPath: string | null = null;

/** Timestamp when the session lock was acquired — used to detect false-positive
 *  onCompromised events from event loop stalls within the stale window (#1362). */
let _lockAcquiredAt: number = 0;

const LOCK_FILE = "auto.lock";

// ─── Test seams (D008/MEM074) ───────────────────────────────────────────────
// Indirections that let race/TOCTOU tests substitute the proper-lockfile API
// and the local `isPidAlive` without spawning real concurrent processes.
// Both default to null; production callsites consult the override first and
// fall back to the real implementation. See `_setLockfileForTests` /
// `_setIsPidAliveForTests` for the test-side entry points.

/** Override for `_require("proper-lockfile")` resolution. */
let _activeLockfile: ProperLockfileApi | null = null;

/** Sentinel that forces the `_require("proper-lockfile")` path to fail
 *  (simulates "package not installed") so tests can drive `acquireFallbackLock`. */
let _forceLockfileUnavailable: boolean = false;

/** Override for the local `isPidAlive` helper used by `safeCleanupStaleLock`
 *  and the orphan checks. Independent from the seam in `session-status-io.ts`. */
let _activeIsPidAlive: ((pid: number) => boolean) | null = null;

/**
 * Test-only: substitute the proper-lockfile implementation for all callsites
 * inside this module. Pass an object with `lockSync` to intercept; pass the
 * sentinel to force the require() to fail (drives `acquireFallbackLock`).
 * Pass `null` to clear the override.
 */
export function _setLockfileForTests(impl: ProperLockfileApi | "unavailable" | null): void {
  if (impl === "unavailable") {
    _activeLockfile = null;
    _forceLockfileUnavailable = true;
    return;
  }
  _activeLockfile = impl;
  _forceLockfileUnavailable = false;
}

/** Test-only: clear the proper-lockfile override. */
export function _resetLockfileForTests(): void {
  _activeLockfile = null;
  _forceLockfileUnavailable = false;
}

/**
 * Test-only: substitute the LOCAL `isPidAlive` used by `safeCleanupStaleLock`
 * and other orphan checks inside this module. The session-status-io seam is
 * separate; this one fences race tests against the cleanup helper specifically.
 */
export function _setIsPidAliveForTests(impl: ((pid: number) => boolean) | null): void {
  _activeIsPidAlive = impl;
}

/** Test-only: clear the local isPidAlive override. */
export function _resetIsPidAliveForTests(): void {
  _activeIsPidAlive = null;
}

/** Resolve the proper-lockfile API, honoring the test override. Throws when
 *  forced unavailable so the existing try/catch routes to `acquireFallbackLock`. */
function resolveLockfile(): ProperLockfileApi {
  if (_forceLockfileUnavailable) {
    throw new Error("proper-lockfile unavailable (test sentinel)");
  }
  if (_activeLockfile) return _activeLockfile;
  return _require("proper-lockfile") as ProperLockfileApi;
}

/**
 * Derive the effective lock file name for the current process.
 * In parallel worker mode (GSD_PARALLEL_WORKER + GSD_MILESTONE_LOCK),
 * each worker uses a per-milestone lock file (`auto-<milestoneId>.lock`)
 * to avoid contending on the shared `.gsd/auto.lock` (#2184).
 */
export function effectiveLockFile(): string {
  const mid = process.env.GSD_PARALLEL_WORKER ? process.env.GSD_MILESTONE_LOCK : null;
  return mid ? `auto-${mid}.lock` : LOCK_FILE;
}

/**
 * Derive the OS-level lock target directory for the current process.
 * In parallel worker mode, uses `.gsd/parallel/<milestoneId>/` instead of
 * `.gsd/` so workers don't contend on the same proper-lockfile directory (#2184).
 */
export function effectiveLockTarget(gsdDir: string): string {
  const mid = process.env.GSD_PARALLEL_WORKER ? process.env.GSD_MILESTONE_LOCK : null;
  return mid ? join(gsdDir, "parallel", mid) : gsdDir;
}

function lockPath(basePath: string): string {
  // If we have a snapshotted path from acquisition, use it for consistency
  if (_snapshotLockPath) return _snapshotLockPath;
  return join(gsdRoot(basePath), effectiveLockFile());
}

// ─── Stray Lock Cleanup ─────────────────────────────────────────────────────

/**
 * Remove numbered lock file variants (e.g. "auto 2.lock", "auto 3.lock")
 * that accumulate from macOS file conflict resolution (iCloud/Dropbox/OneDrive)
 * or other filesystem-level copy-on-conflict behavior (#1315).
 *
 * Also removes stray proper-lockfile directories beyond the canonical `.gsd.lock/`.
 */
export function cleanupStrayLockFiles(basePath: string): void {
  const gsdDir = gsdRoot(basePath);

  // Clean numbered auto lock files inside .gsd/
  try {
    if (existsSync(gsdDir)) {
      for (const entry of readdirSync(gsdDir)) {
        // Match "auto <N>.lock" or "auto (<N>).lock" variants but NOT the canonical "auto.lock"
        if (entry !== LOCK_FILE && /^auto\s.+\.lock$/i.test(entry)) {
          try { unlinkSync(join(gsdDir, entry)); } catch { /* best-effort */ }
        }
      }
    }
  } catch { /* non-fatal: directory read failure */ }

  // Clean stray proper-lockfile directories (e.g. ".gsd 2.lock/")
  // The canonical one is ".gsd.lock/" — anything else is stray.
  try {
    const parentDir = dirname(gsdDir);
    const gsdDirName = gsdDir.split("/").pop() || ".gsd";
    if (existsSync(parentDir)) {
      for (const entry of readdirSync(parentDir)) {
        // Match ".gsd <N>.lock" or ".gsd (<N>).lock" directories but NOT ".gsd.lock"
        if (entry !== `${gsdDirName}.lock` && entry.startsWith(gsdDirName) && entry.endsWith(".lock")) {
          const fullPath = join(parentDir, entry);
          try {
            const stat = statSync(fullPath);
            if (stat.isDirectory()) {
              rmSync(fullPath, { recursive: true, force: true });
            }
          } catch { /* best-effort */ }
        }
      }
    }
  } catch { /* non-fatal */ }
}

/**
 * Register a single process exit handler that cleans up lock state.
 * Uses module-level references so it always operates on current state.
 * Only registers once — subsequent calls are no-ops.
 */
function ensureExitHandler(_gsdDir: string): void {
  // Register the gsdDir so exit cleanup covers it
  _lockDirRegistry.add(_gsdDir);

  if (_exitHandlerRegistered) return;
  _exitHandlerRegistered = true;

  process.once("exit", () => {
    try {
      if (_releaseFunction) { _releaseFunction(); _releaseFunction = null; }
    } catch { /* best-effort */ }
    // Clean ALL registered lock paths, not just the current one (#1578).
    // Lock files accumulate across main project .gsd/, worktree .gsd/,
    // and projects registry paths — cleanup must cover all of them.
    for (const dir of _lockDirRegistry) {
      const lockFile = join(dir, LOCK_FILE);
      const ownsRegisteredLock = isLockFileOwnedByCurrentProcess(lockFile);
      try {
        if (ownsRegisteredLock && existsSync(lockFile)) unlinkSync(lockFile);
      } catch { /* best-effort */ }
      try {
        const lockDir = join(dir + ".lock");
        if (ownsRegisteredLock && existsSync(lockDir)) rmSync(lockDir, { recursive: true, force: true });
      } catch { /* best-effort */ }
    }
  });
}

// ─── Lock Acquisition Helpers ───────────────────────────────────────────────

/**
 * Create the onCompromised callback for proper-lockfile.
 *
 * proper-lockfile fires onCompromised when it detects mtime drift (system sleep,
 * event loop stall, etc.). The default handler throws inside setTimeout — an
 * uncaught exception that crashes or corrupts process state.
 *
 * False-positive suppression (#1362): If we're still within the stale window
 * (30 min since acquisition), the mtime mismatch is from an event loop stall
 * during a long LLM call — not a real takeover. Log and continue.
 *
 * PID ownership check (#1578): Past the stale window, check if the lock file
 * still contains our PID before declaring compromise. Retry reads tolerate
 * transient filesystem hiccups (NFS/CIFS latency, APFS snapshots, etc.) (#2324).
 */
function createLockCompromisedHandler(lockFilePath: string): () => void {
  return () => {
    const elapsed = Date.now() - _lockAcquiredAt;
    if (elapsed < 1_800_000) {
      process.stderr.write(
        `[gsd] Lock heartbeat caught up after ${Math.round(elapsed / 1000)}s — long LLM call, no action needed.\n`,
      );
      return;
    }
    const existing = readExistingLockDataWithRetry(lockFilePath);
    if (existing && existing.pid === process.pid) {
      process.stderr.write(
        `[gsd] Lock heartbeat mismatch after ${Math.round(elapsed / 1000)}s — lock file still owned by PID ${process.pid}, treating as false positive.\n`,
      );
      return;
    }
    _lockCompromised = true;
    _releaseFunction = null;
  };
}

/**
 * Assign module-level lock state after a successful lock acquisition.
 */
function assignLockState(basePath: string, release: () => void, lockFilePath: string): void {
  _releaseFunction = release;
  _lockedPath = basePath;
  _lockPid = process.pid;
  _lockCompromised = false;
  _lockAcquiredAt = Date.now();
  _snapshotLockPath = lockFilePath;
}

/**
 * TOCTOU-safe stale lock cleanup (M003/S02 Bug 2, R009).
 *
 * Replaces the prior inline `if (orphan) { rmSync; unlinkSync }` blocks at the
 * pre-flight site (originally `session-lock.ts:308-316`) and the retry-after-
 * fail site (originally `session-lock.ts:349-372`). Both blocks shared a TOCTOU
 * window: between the PID-dead check and the actual `rmSync`, a fresh owner
 * could win the proper-lockfile claim and write its own `auto.lock` — the
 * inline cleanup would then stomp the fresh owner's metadata.
 *
 * Sequence (claim-then-validate, per S02-RESEARCH "Recommendation"):
 *   1. Read existing `auto.lock` data.
 *   2. **First PID check** — if data exists AND `isPidAlive(existingData.pid)`
 *      is true, the fresh owner already won; abort cleanup with `ok: false`.
 *   3. **Take an O_EXCL claim** on the lock target via `lockfile.lockSync` —
 *      short-lived, fences other concurrent cleaners.
 *   4. **Second PID check** (TOCTOU close) — re-read the lock data; if it has
 *      changed (different PID/startedAt) OR the PID is now alive, release the
 *      claim and abort with `ok: false`.
 *   5. Only after both checks pass, `rmSync(lockDir)` + `unlinkSync(lp)`.
 *   6. Release the claim and return `ok: true`.
 *
 * CRITICAL: the helper releases its claim BEFORE returning so the caller can
 * immediately attempt the production `lockfile.lockSync` without contending
 * with the cleanup-helper's own claim on the same target.
 */
export function safeCleanupStaleLock(
  lockTarget: string,
  lp: string,
  lockfile: ProperLockfileApi,
): { ok: true } | { ok: false; existingPid?: number } {
  // (1) Read current lock data
  const initial = readExistingLockData(lp);

  // (2) First PID check — fresh owner already won?
  if (initial && initial.pid && isPidAlive(initial.pid)) {
    return { ok: false, existingPid: initial.pid };
  }

  // (3) Take an O_EXCL claim to fence other cleaners
  let release: (() => void) | null = null;
  try {
    release = lockfile.lockSync(lockTarget, {
      realpath: false,
      stale: 1_800_000, // match production settings (line 320-325)
      update: 10_000,
    });
  } catch {
    // Could not take the claim — another process is already cleaning OR holds
    // the production lock. Treat as "fresh owner already won" — fall through to
    // existing actionable-error path; caller's lockSync will surface the
    // contended-lock message.
    const after = readExistingLockData(lp);
    return { ok: false, existingPid: after?.pid };
  }

  try {
    // (4) Second PID check — has anyone written fresh metadata while we were
    // taking the claim, or is the PID now alive?
    const recheck = readExistingLockData(lp);
    if (recheck) {
      const changed =
        !initial ||
        recheck.pid !== initial.pid ||
        recheck.startedAt !== initial.startedAt;
      if (changed || (recheck.pid && isPidAlive(recheck.pid))) {
        return { ok: false, existingPid: recheck.pid };
      }
    }

    // (5) Both checks passed — safe to wipe stale state
    const lockDir = lockTarget + ".lock";
    try { rmSync(lockDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    try { if (existsSync(lp)) unlinkSync(lp); } catch { /* best-effort */ }

    return { ok: true };
  } finally {
    // (6) Release the claim before returning so the caller's production
    // lockSync attempt does not contend with the cleanup-helper's own claim
    // on the same target.
    if (release) {
      try { release(); } catch { /* best-effort */ }
    }
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Attempt to acquire an exclusive session lock for the given project.
 *
 * This uses proper-lockfile for OS-level file locking. If another process
 * already holds the lock, this returns { acquired: false } with details.
 *
 * The lock file also contains JSON metadata about the session for
 * diagnostic purposes (PID, unit info, etc.).
 */
export function acquireSessionLock(basePath: string): SessionLockResult {
  const lp = lockPath(basePath);

  // Re-entrant acquire on the same path: release our current OS lock first so
  // proper-lockfile clears its update timer before we acquire a fresh lock.
  if (_releaseFunction && _lockedPath === basePath) {
    try { _releaseFunction(); } catch { /* may already be released */ }
    _releaseFunction = null;
    _lockedPath = null;
    _lockPid = 0;
    _lockCompromised = false;
  }

  // Ensure the directory exists
  mkdirSync(dirname(lp), { recursive: true });

  // Clean up numbered lock file variants from cloud sync conflicts (#1315)
  cleanupStrayLockFiles(basePath);

  // Write our lock data first (the content is informational; the OS lock is the real guard)
  const lockData: SessionLockData = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    unitType: "starting",
    unitId: "bootstrap",
    unitStartedAt: new Date().toISOString(),
  };

  let lockfile: ProperLockfileApi;
  try {
    lockfile = resolveLockfile();
  } catch {
    // proper-lockfile not available — fall back to PID-based check
    return acquireFallbackLock(basePath, lp, lockData);
  }

  const gsdDir = gsdRoot(basePath);
  const lockTarget = effectiveLockTarget(gsdDir);

  // #3218 + M003/S02 Bug 2 (R009): Pre-flight stale lock cleanup. If the
  // `.lock/` directory exists, attempt a TOCTOU-safe cleanup via
  // `safeCleanupStaleLock`. On `{ ok: false }` (fresh owner won the race) we
  // skip cleanup and proceed — the production `lockfile.lockSync` below will
  // then fail with the actionable contended-lock message via the catch-arm.
  const lockDir = lockTarget + ".lock";
  if (existsSync(lockDir)) {
    safeCleanupStaleLock(lockTarget, lp, lockfile);
    // Result intentionally ignored — both ok:true and ok:false paths converge
    // on attempting the production lockSync below.
  }

  try {
    // Try to acquire an exclusive OS-level lock on the lock target.
    // We lock a directory since proper-lockfile works best on directories,
    // and the lock file itself may not exist yet.
    // In parallel worker mode, lockTarget is .gsd/parallel/<MID>/ (#2184).
    mkdirSync(lockTarget, { recursive: true });

    const release = lockfile.lockSync(lockTarget, {
      realpath: false,
      stale: 1_800_000, // 30 minutes — safe for laptop sleep / long event loop stalls
      update: 10_000, // Update lock mtime every 10s to prove liveness
      onCompromised: createLockCompromisedHandler(lp),
    });

    assignLockState(basePath, release, lp);

    // Safety net: clean up lock dir on process exit if _releaseFunction
    // wasn't called (e.g., normal exit after clean completion) (#1245).
    ensureExitHandler(lockTarget);

    // Write the informational lock data
    atomicWriteSync(lp, JSON.stringify(lockData, null, 2));

    return { acquired: true };
  } catch (err) {
    // Lock is held by another process — or the .gsd.lock/ directory is stranded.
    // Check: if auto.lock is gone and no process is alive, the lock dir is stale.
    const existingData = readExistingLockData(lp);
    const existingPid = existingData?.pid;

    // If no lock file or no alive process, attempt TOCTOU-safe cleanup and
    // re-acquire (#1245 + M003/S02 Bug 2 R009).
    //
    // The prior inline `rmSync` + `unlinkSync` + immediate `lockSync` retry
    // had a race window: between the `isPidAlive` check above and the inline
    // `rmSync`, a fresh owner could win the proper-lockfile claim and write
    // its own `auto.lock` — the inline cleanup would stomp it.
    //
    // `safeCleanupStaleLock` does claim-then-validate (first PID check →
    // O_EXCL claim → second PID check → only-then wipe → release claim). On
    // `{ ok: false }` the fresh owner already won; we MUST NOT auto-retry the
    // acquire — fall through to the existing actionable-error path below so
    // the late acquirer sees the standard contended-lock message.
    if (!existingData || (existingPid && !isPidAlive(existingPid))) {
      const cleanup = safeCleanupStaleLock(lockTarget, lp, lockfile);
      if (cleanup.ok) {
        try {
          // Retry acquisition after cleanup
          const release = lockfile.lockSync(lockTarget, {
            realpath: false,
            stale: 1_800_000, // 30 minutes — match primary lock settings
            update: 10_000,
            onCompromised: createLockCompromisedHandler(lp),
          });
          assignLockState(basePath, release, lp);

          // Safety net — uses centralized handler to avoid double-registration
          ensureExitHandler(lockTarget);

          atomicWriteSync(lp, JSON.stringify(lockData, null, 2));
          return { acquired: true };
        } catch {
          // Retry also failed — fall through to the error path with refreshed PID
        }
      }
      // cleanup.ok === false: fresh owner won the race; surface its PID in the
      // actionable error below by re-reading the lock data.
    }

    // #3218: Provide actionable workaround when lock recovery fails.
    // Re-read the lock file in case a fresh owner appeared during cleanup.
    const finalData = readExistingLockData(lp);
    const finalPid = finalData?.pid ?? existingPid;
    const lockDirPath = lockTarget + ".lock";
    const reason = finalPid
      ? `Another auto-mode session (PID ${finalPid}) appears to be running.\nStop it with \`kill ${finalPid}\` before starting a new session.`
      : `Another auto-mode session lock is stuck on this project.\nRun: rm -rf "${lockDirPath}" && rm -f "${lp}"`;

    return { acquired: false, reason, existingPid: finalPid };
  }
}

/**
 * Fallback lock acquisition when proper-lockfile is not available.
 * Uses PID-based liveness checking (the old approach, but with the lock
 * written BEFORE initialization rather than after).
 */
function acquireFallbackLock(
  basePath: string,
  lp: string,
  lockData: SessionLockData,
): SessionLockResult {
  // Check if an existing lock is held by a live process
  const existing = readExistingLockData(lp);
  if (existing && existing.pid !== process.pid) {
    if (isPidAlive(existing.pid)) {
      return {
        acquired: false,
        reason: `Another auto-mode session (PID ${existing.pid}) is already running on this project.`,
        existingPid: existing.pid,
      };
    }
    // Stale lock from dead process — we can take over
  }

  // Write our lock data
  atomicWriteSync(lp, JSON.stringify(lockData, null, 2));
  _lockedPath = basePath;
  _lockPid = process.pid;

  return { acquired: true };
}

/**
 * Update the lock file metadata (called on each unit dispatch).
 * Does NOT re-acquire the OS lock — just updates the JSON content.
 */
export function updateSessionLock(
  basePath: string,
  unitType: string,
  unitId: string,
  sessionFile?: string,
): void {
  if (_lockedPath !== basePath && _lockedPath !== null) return;

  const lp = lockPath(basePath);
  try {
    const data: SessionLockData = {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      unitType,
      unitId,
      unitStartedAt: new Date().toISOString(),
      sessionFile,
    };
    atomicWriteSync(lp, JSON.stringify(data, null, 2));
  } catch {
    // Non-fatal: lock update failure
  }
}

/**
 * Validate that we still own the session lock.
 *
 * Returns true if we still hold the lock, false if another process
 * has taken over (indicating we should gracefully stop).
 *
 * This is called periodically during the dispatch loop.
 */
export function getSessionLockStatus(basePath: string): SessionLockStatus {
  // Lock was compromised by proper-lockfile (mtime drift from sleep, stall, etc.)
  if (_lockCompromised) {
    // Recovery gate (#1512): Before declaring the lock lost, check if the lock
    // file still contains our PID. If it does, no other process took over — the
    // onCompromised fired from benign mtime drift (laptop sleep, event loop stall
    // beyond the stale window). Attempt re-acquisition instead of giving up.
    const lp = lockPath(basePath);
    // Retry reads to tolerate transient filesystem hiccups (#2324).
    const existing = readExistingLockDataWithRetry(lp);
    if (existing && existing.pid === process.pid) {
      // Lock file still ours — try to re-acquire the OS lock
      try {
        const result = acquireSessionLock(basePath);
        if (result.acquired) {
          process.stderr.write(
            `[gsd] Lock recovered after onCompromised — lock file PID matched, re-acquired.\n`,
          );
          return { valid: true, recovered: true };
        }
      } catch {
        // Re-acquisition failed — fall through to return false
      }
    }
    return {
      valid: false,
      failureReason: "compromised",
      existingPid: existing?.pid,
      expectedPid: process.pid,
    };
  }

  // If we have an OS-level lock, we're still the owner
  if (_releaseFunction && _lockedPath === basePath) {
    return { valid: true };
  }

  // Fallback: check the lock file PID
  const lp = lockPath(basePath);
  const existing = readExistingLockData(lp);
  if (!existing) {
    // Lock file was deleted — we lost ownership
    return {
      valid: false,
      failureReason: "missing-metadata",
      expectedPid: process.pid,
    };
  }

  if (existing.pid !== process.pid) {
    return {
      valid: false,
      failureReason: "pid-mismatch",
      existingPid: existing.pid,
      expectedPid: process.pid,
    };
  }

  return { valid: true };
}

export function validateSessionLock(basePath: string): boolean {
  return getSessionLockStatus(basePath).valid;
}

/**
 * Release the session lock. Called on clean stop/pause.
 */
export function releaseSessionLock(basePath: string): void {
  // Release the OS-level lock
  if (_releaseFunction) {
    try {
      _releaseFunction();
    } catch {
      // Lock may already be released
    }
    _releaseFunction = null;
  }

  // Remove the lock file at the current path only if it still belongs to us.
  // Lost-lock cleanup can run after another process has taken ownership; in
  // that case deleting auto.lock would erase the newer owner's evidence.
  const lp = lockPath(basePath);
  const ownsPrimaryLock = isLockFileOwnedByCurrentProcess(lp);
  try {
    if (ownsPrimaryLock && existsSync(lp)) unlinkSync(lp);
  } catch {
    // Non-fatal
  }

  // Remove the proper-lockfile directory for the current lock target.
  // In parallel worker mode, this is .gsd/parallel/<MID>.lock/ (#2184).
  const gsdDir = gsdRoot(basePath);
  const lockTarget = effectiveLockTarget(gsdDir);
  try {
    const lockDir = join(lockTarget + ".lock");
    if (ownsPrimaryLock && existsSync(lockDir)) rmSync(lockDir, { recursive: true, force: true });
  } catch {
    // Non-fatal
  }
  // Also clean the per-milestone parallel directory itself if it exists
  if (ownsPrimaryLock && lockTarget !== gsdDir) {
    try {
      if (existsSync(lockTarget)) rmSync(lockTarget, { recursive: true, force: true });
    } catch {
      // Non-fatal
    }
  }

  // Clean ALL registered lock paths (#1578) — lock files accumulate across
  // main project .gsd/, worktree .gsd/, and projects registry paths.
  for (const dir of _lockDirRegistry) {
    const lockFile = join(dir, LOCK_FILE);
    const ownsRegisteredLock = isLockFileOwnedByCurrentProcess(lockFile);
    try {
      if (ownsRegisteredLock && existsSync(lockFile)) unlinkSync(lockFile);
    } catch { /* best-effort */ }
    try {
      const lockDir = join(dir + ".lock");
      if (ownsRegisteredLock && existsSync(lockDir)) rmSync(lockDir, { recursive: true, force: true });
    } catch { /* best-effort */ }
  }
  _lockDirRegistry.clear();

  // Clean up numbered lock file variants from cloud sync conflicts (#1315)
  cleanupStrayLockFiles(basePath);

  _lockedPath = null;
  _lockPid = 0;
  _lockCompromised = false;
  _lockAcquiredAt = 0;
  _snapshotLockPath = null;
}

/**
 * Check if a session lock exists and return its data (for crash recovery).
 * Does NOT acquire the lock.
 */
export function readSessionLockData(basePath: string): SessionLockData | null {
  return readExistingLockData(lockPath(basePath));
}

/**
 * Check if the process that wrote the lock is still alive.
 */
export function isSessionLockProcessAlive(data: SessionLockData): boolean {
  return isPidAlive(data.pid);
}

/**
 * Returns true if we currently hold a session lock for the given path.
 */
export function isSessionLockHeld(basePath: string): boolean {
  return _lockedPath === basePath && _lockPid === process.pid;
}

/**
 * Returns a snapshot of the registered lock directory paths for diagnostics.
 * Exported for tests only.
 */
export function _getRegisteredLockDirs(): string[] {
  return [..._lockDirRegistry];
}

// ─── Internal Helpers ───────────────────────────────────────────────────────

function readExistingLockData(lp: string): SessionLockData | null {
  try {
    if (!existsSync(lp)) return null;
    const raw = readFileSync(lp, "utf-8");
    return JSON.parse(raw) as SessionLockData;
  } catch {
    return null;
  }
}

function isLockFileOwnedByCurrentProcess(lp: string): boolean {
  const existing = readExistingLockData(lp);
  return existing?.pid === process.pid;
}

/**
 * Retry-tolerant variant of readExistingLockData for use in onCompromised and
 * other paths where a transient filesystem hiccup (NFS/CIFS latency, macOS APFS
 * snapshot, concurrent process briefly holding the file) should NOT be treated
 * as "lock file gone" (#2324).
 *
 * Retries up to `maxAttempts` times with `delayMs` between each attempt.
 * Only returns null when ALL retries fail to read valid data.
 */
export interface RetryOptions {
  maxAttempts?: number;
  delayMs?: number;
}

export function readExistingLockDataWithRetry(
  lp: string,
  options?: RetryOptions,
): SessionLockData | null {
  const maxAttempts = options?.maxAttempts ?? 3;
  const delayMs = options?.delayMs ?? 200;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const data = readExistingLockData(lp);
    if (data !== null) return data;
    if (attempt < maxAttempts) {
      // Synchronous busy-wait — onCompromised runs in a sync callback context
      // and the delays are short (200ms default).
      const start = Date.now();
      while (Date.now() - start < delayMs) {
        // busy-wait
      }
    }
  }
  return null;
}

/** Default EPERM-aware `isPidAlive`. Exported so tests can call the real
 *  branch logic directly when stubbing `process.kill`. */
export function _defaultIsPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EPERM") return true;
    return false;
  }
}

function isPidAlive(pid: number): boolean {
  return (_activeIsPidAlive ?? _defaultIsPidAlive)(pid);
}
