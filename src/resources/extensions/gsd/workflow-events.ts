import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteSync } from "./atomic-write.js";
import { withFileLockSync } from "./file-lock.js";
import { logWarning } from "./workflow-logger.js";

// ─── Session ID ───────────────────────────────────────────────────────────

/**
 * Engine-generated session ID — stable for the lifetime of this process.
 * Agents can reference this to correlate all events from one run.
 */
const ENGINE_SESSION_ID: string = randomUUID();

export function getSessionId(): string {
  return ENGINE_SESSION_ID;
}

// ─── Event Types ─────────────────────────────────────────────────────────

export interface WorkflowEvent {
  v?: number;              // schema version — omitted in v1 (legacy), 2 for current format
  cmd: string;             // e.g. "complete-task" (canonical: hyphens; legacy: underscores — both accepted by replay)
  params: Record<string, unknown>;
  ts: string;              // ISO 8601
  hash: string;            // content hash (hex, 16 chars)
  actor: "agent" | "system";
  actor_name?: string;      // e.g. "executor-agent-01" — caller-provided identity
  trigger_reason?: string;  // e.g. "plan-phase complete" — caller-provided causation
  session_id: string;       // engine-generated UUID, stable per process lifetime
}

// ─── appendEvent test seam (D008, M003/S01 Bug 1) ────────────────────────

/**
 * Test-only seam that lets `tests/workflow-events-append-race.test.ts`
 * deterministically interleave `appendEvent`'s file-locked write against a
 * planted `compactMilestoneEvents` truncate. Production code paths must
 * never set this — only `_setAppendEventFsForTests` from the race test.
 *
 * Both functions fall back to the real `appendFileSync` / `withFileLockSync`
 * imports when the corresponding override is absent. Underscore-prefixed per
 * the project D008 seam-injection convention; reset to `null` in `afterEach`.
 */
interface AppendEventFsOverrides {
  appendFileSync?: typeof appendFileSync;
  withFileLockSync?: typeof withFileLockSync;
}

let _activeAppendEventFs: AppendEventFsOverrides | null = null;

export function _setAppendEventFsForTests(impl: AppendEventFsOverrides | null): void {
  _activeAppendEventFs = impl;
}

export function _resetAppendEventFsForTests(): void {
  _activeAppendEventFs = null;
}

// ─── appendEvent ─────────────────────────────────────────────────────────

/**
 * Append one event to .gsd/event-log.jsonl.
 * Computes a content hash from cmd+params (deterministic, independent of ts/actor/session).
 * Creates .gsd directory if needed.
 *
 * Cross-process safety (M003/S01 Bug 1): the actual content append runs
 * inside `withFileLockSync(logPath, ...)`, the same proper-lockfile primitive
 * `compactMilestoneEvents` already uses. ELOCKED bubbles up raw to the
 * caller (per S01-CONTEXT — no `GSD_EVENT_LOG_BUSY` wrapper, no retry
 * tuning) after the default 5 × 50ms = 250ms wait.
 *
 * The `mkdirSync(.gsd/)` and the no-op touch run OUTSIDE the lock because
 * `withFileLockSync` early-returns when the target file does not exist
 * (`file-lock.ts:79`). Without the touch, the very first append in a fresh
 * project would bypass the lock entirely. The touch is itself idempotent
 * (empty string append) so two racing touches are harmless.
 */
export function appendEvent(
  basePath: string,
  event: Omit<WorkflowEvent, "hash" | "session_id"> & { actor_name?: string; trigger_reason?: string },
): void {
  const hash = createHash("sha256")
    .update(JSON.stringify({ cmd: event.cmd, params: event.params }))
    .digest("hex")
    .slice(0, 16);

  const fullEvent: WorkflowEvent = {
    v: 2,
    ...event,
    hash,
    session_id: ENGINE_SESSION_ID,
  };
  const dir = join(basePath, ".gsd");
  mkdirSync(dir, { recursive: true });
  const logPath = join(dir, "event-log.jsonl");

  // Pre-create the log so withFileLockSync actually engages on the first
  // event (see jsdoc above). Use the REAL appendFileSync so race tests that
  // inject via `_setAppendEventFsForTests` only intercept the actual event
  // write inside the lock body, not this idempotent touch.
  if (!existsSync(logPath)) {
    appendFileSync(logPath, "", "utf-8");
  }

  const appendFn = _activeAppendEventFs?.appendFileSync ?? appendFileSync;
  const lockFn = _activeAppendEventFs?.withFileLockSync ?? withFileLockSync;

  lockFn(logPath, () => {
    appendFn(logPath, JSON.stringify(fullEvent) + "\n", "utf-8");
  });
}

// ─── readEvents ──────────────────────────────────────────────────────────

/**
 * Read all events from a JSONL file.
 * Returns empty array if file doesn't exist.
 * Corrupted lines are skipped with stderr warning.
 */
export function readEvents(logPath: string): WorkflowEvent[] {
  if (!existsSync(logPath)) {
    return [];
  }

  const content = readFileSync(logPath, "utf-8");
  const lines = content.split("\n").filter((l) => l.length > 0);
  const events: WorkflowEvent[] = [];

  for (const line of lines) {
    try {
      events.push(JSON.parse(line) as WorkflowEvent);
    } catch {
      logWarning("event-log", `skipping corrupted event line (${line.length} bytes)`);
    }
  }

  return events;
}

// ─── findForkPoint ───────────────────────────────────────────────────────

/**
 * Find the index of the last common event between two logs by comparing hashes.
 * Returns -1 if the first events differ (completely diverged).
 * If one log is a prefix of the other, returns length of shorter - 1.
 */
export function findForkPoint(
  logA: WorkflowEvent[],
  logB: WorkflowEvent[],
): number {
  const minLen = Math.min(logA.length, logB.length);
  let lastCommon = -1;

  for (let i = 0; i < minLen; i++) {
    if (logA[i]!.hash === logB[i]!.hash) {
      lastCommon = i;
    } else {
      break;
    }
  }

  return lastCommon;
}

// ─── compactMilestoneEvents ─────────────────────────────────────────────────

/**
 * Archive a milestone's events from the active log to a separate file.
 * Active log retains only events from other milestones.
 * Archived file is kept on disk for forensics.
 *
 * @param basePath - Project root (parent of .gsd/)
 * @param milestoneId - The milestone whose events should be archived
 * @returns { archived: number } — count of events moved to archive
 */
export function compactMilestoneEvents(
  basePath: string,
  milestoneId: string,
): { archived: number } {
  const logPath = join(basePath, ".gsd", "event-log.jsonl");
  const archivePath = join(basePath, ".gsd", `event-log-${milestoneId}.jsonl.archived`);

  return withFileLockSync(logPath, () => {
    const allEvents = readEvents(logPath);
    
    // Single-pass partition to halve the work (per reviewer agent)
    const toArchive: WorkflowEvent[] = [];
    const remaining: WorkflowEvent[] = [];
    
    for (const e of allEvents) {
      if ((e.params as { milestoneId?: string }).milestoneId === milestoneId) {
        toArchive.push(e);
      } else {
        remaining.push(e);
      }
    }

    if (toArchive.length === 0) {
      return { archived: 0 };
    }

    // Write archived events to .jsonl.archived file (crash-safe)
    atomicWriteSync(
      archivePath,
      toArchive.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );

    // Truncate active log to remaining events only
    atomicWriteSync(
      logPath,
      remaining.length > 0
        ? remaining.map((e) => JSON.stringify(e)).join("\n") + "\n"
        : "",
    );

    return { archived: toArchive.length };
  });
}
