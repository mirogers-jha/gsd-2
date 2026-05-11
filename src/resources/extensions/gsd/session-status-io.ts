/**
 * GSD Session Status I/O
 *
 * File-based IPC protocol for coordinator-worker communication in
 * parallel milestone orchestration. Each worker writes its status to a
 * file; the coordinator reads all status files to monitor progress.
 *
 * Atomic writes (write to .tmp, then rename) prevent partial reads.
 * Signal files let the coordinator send pause/resume/stop/rebase to workers.
 * Stale detection combines PID liveness checks with heartbeat timeouts.
 */

import {
  unlinkSync,
  readdirSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { gsdRoot } from "./paths.js";
import { loadJsonFileOrNull, writeJsonFileAtomic } from "./json-persistence.js";

// ─── Types ─────────────────────────────────────────────────────────────────

export interface SessionStatus {
  milestoneId: string;
  pid: number;
  state: "running" | "paused" | "stopped" | "error";
  currentUnit: { type: string; id: string; startedAt: number } | null;
  completedUnits: number;
  cost: number;
  lastHeartbeat: number;
  startedAt: number;
  worktreePath: string;
}

export type SessionSignal = "pause" | "resume" | "stop" | "rebase";

export interface SignalMessage {
  signal: SessionSignal;
  sentAt: number;
  from: "coordinator";
}

// ─── Constants ─────────────────────────────────────────────────────────────

const PARALLEL_DIR = "parallel";
const STATUS_SUFFIX = ".status.json";
const SIGNAL_SUFFIX = ".signal.json";
const DEFAULT_STALE_TIMEOUT_MS = 30_000;

function isSessionStatus(data: unknown): data is SessionStatus {
  return data !== null && typeof data === "object" && "milestoneId" in data && "pid" in data;
}

function isSignalMessage(data: unknown): data is SignalMessage {
  return data !== null && typeof data === "object" && "signal" in data && "sentAt" in data;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function parallelDir(basePath: string): string {
  return join(gsdRoot(basePath), PARALLEL_DIR);
}

function statusPath(basePath: string, milestoneId: string): string {
  return join(parallelDir(basePath), `${milestoneId}${STATUS_SUFFIX}`);
}

function signalPath(basePath: string, milestoneId: string): string {
  return join(parallelDir(basePath), `${milestoneId}${SIGNAL_SUFFIX}`);
}

function ensureParallelDir(basePath: string): void {
  const dir = parallelDir(basePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

// Test seam (D008/MEM074): module-level indirection so D004 reproduce-and-prevent
// tests can substitute `isPidAlive` without spawning real foreign-uid PIDs.
// Production callsites (currently `isSessionStale` only) route through this
// indirection and fall back to `_defaultIsPidAlive` when the override is null.
let _activeIsPidAlive: ((pid: number) => boolean) | null = null;

/**
 * Real `isPidAlive` implementation. Exported (`_defaultIsPidAlive`) only so the
 * EPERM unit test can exercise the actual error-code branches by stubbing
 * `process.kill` directly. Branch shape matches the EPERM-aware cousins at
 * `session-lock.ts:668`, `sync-lock.ts:26-33`, and
 * `slice-parallel-orchestrator.ts:114-122` (M003/S02 cousin audit).
 *
 *   EPERM   → true  (foreign-uid alive — multi-uid CI must not wipe these)
 *   ESRCH   → false (truly dead — safe to clean up)
 *   ENOENT  → false (no such process on platforms that surface this code)
 *   unknown → true  (fail-safe: prefer keeping a maybe-alive session over
 *                    nuking a real one on an unfamiliar errno)
 */
export function _defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM") return true;
    if (code === "ESRCH") return false;
    if (code === "ENOENT") return false;
    return true;
  }
}

function isPidAlive(pid: number): boolean {
  return (_activeIsPidAlive ?? _defaultIsPidAlive)(pid);
}

/** Test seam: install a fake `isPidAlive` for `isSessionStale` / `cleanupStaleSessions`. */
export function _setIsPidAliveForTests(impl: ((pid: number) => boolean) | null): void {
  _activeIsPidAlive = impl;
}

/** Test seam: reset the override back to the real implementation. */
export function _resetIsPidAliveForTests(): void {
  _activeIsPidAlive = null;
}

// ─── Status I/O ────────────────────────────────────────────────────────────

/** Write session status atomically (write to .tmp, then rename). */
export function writeSessionStatus(basePath: string, status: SessionStatus): void {
  ensureParallelDir(basePath);
  writeJsonFileAtomic(statusPath(basePath, status.milestoneId), status);
}

/** Read a specific milestone's session status. */
export function readSessionStatus(basePath: string, milestoneId: string): SessionStatus | null {
  return loadJsonFileOrNull(statusPath(basePath, milestoneId), isSessionStatus);
}

/** Read all session status files from .gsd/parallel/. */
export function readAllSessionStatuses(basePath: string): SessionStatus[] {
  const dir = parallelDir(basePath);
  if (!existsSync(dir)) return [];

  const results: SessionStatus[] = [];
  try {
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith(STATUS_SUFFIX)) continue;
      const status = loadJsonFileOrNull(join(dir, entry), isSessionStatus);
      if (status) results.push(status);
    }
  } catch { /* non-fatal */ }
  return results;
}

/** Remove a milestone's session status file. */
export function removeSessionStatus(basePath: string, milestoneId: string): void {
  try {
    const p = statusPath(basePath, milestoneId);
    if (existsSync(p)) unlinkSync(p);
  } catch { /* non-fatal */ }
}

// ─── Signal I/O ────────────────────────────────────────────────────────────

/** Write a signal file for a worker to consume. */
export function sendSignal(basePath: string, milestoneId: string, signal: SessionSignal): void {
  ensureParallelDir(basePath);
  const msg: SignalMessage = { signal, sentAt: Date.now(), from: "coordinator" };
  writeJsonFileAtomic(signalPath(basePath, milestoneId), msg);
}

/** Read and delete a signal file (atomic consume). Returns null if no signal pending. */
export function consumeSignal(basePath: string, milestoneId: string): SignalMessage | null {
  const p = signalPath(basePath, milestoneId);
  const msg = loadJsonFileOrNull(p, isSignalMessage);
  if (msg) {
    try { unlinkSync(p); } catch { /* non-fatal */ }
  }
  return msg;
}

// ─── Stale Detection ───────────────────────────────────────────────────────

/** Check whether a session is stale (PID dead or heartbeat timed out). */
export function isSessionStale(
  status: SessionStatus,
  timeoutMs: number = DEFAULT_STALE_TIMEOUT_MS,
): boolean {
  if (!isPidAlive(status.pid)) return true;
  const elapsed = Date.now() - status.lastHeartbeat;
  return elapsed > timeoutMs;
}

/** Find and remove stale sessions. Returns the milestone IDs that were cleaned up. */
export function cleanupStaleSessions(
  basePath: string,
  timeoutMs: number = DEFAULT_STALE_TIMEOUT_MS,
): string[] {
  const removed: string[] = [];
  const statuses = readAllSessionStatuses(basePath);

  for (const status of statuses) {
    if (isSessionStale(status, timeoutMs)) {
      removeSessionStatus(basePath, status.milestoneId);
      // Also clean up any lingering signal file
      try {
        const sig = signalPath(basePath, status.milestoneId);
        if (existsSync(sig)) unlinkSync(sig);
      } catch { /* non-fatal */ }
      removed.push(status.milestoneId);
    }
  }

  return removed;
}
