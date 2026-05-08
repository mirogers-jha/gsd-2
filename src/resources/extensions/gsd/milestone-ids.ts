/**
 * Milestone ID primitives — pure utilities for generating, parsing, sorting,
 * and discovering milestone identifiers.
 *
 * Consumed by 15+ modules across the GSD extension. Zero side-effects.
 */

import { randomInt } from "node:crypto";
import { logWarning } from "./workflow-logger.js";
import { readdirSync, existsSync } from "node:fs";
import { isAbsolute, normalize, basename } from "node:path";
import { milestonesDir } from "./paths.js";
import { loadQueueOrder, sortByQueueOrder } from "./queue-order.js";
import { getErrorMessage } from "./error-utils.js";

// ─── Regex ──────────────────────────────────────────────────────────────────

/** Matches both classic `M001` and unique `M001-abc123` formats (anchored). */
export const MILESTONE_ID_RE = /^M\d{3}(?:-[a-z0-9]{6})?$/;

/** Matches slice IDs (segment-only, anchored). */
export const SLICE_ID_RE = /^S\d{2}$/;

/** Matches task IDs (segment-only, anchored). */
export const TASK_ID_RE = /^T\d{2}$/;

// ─── Parsing & Extraction ───────────────────────────────────────────────────

/** Extract the trailing sequential number from a milestone ID. Returns 0 for non-matches. */
export function extractMilestoneSeq(id: string): number {
  const m = id.match(/^M(\d{3})(?:-[a-z0-9]{6})?$/);
  return m ? parseInt(m[1], 10) : 0;
}

/** Structured parse of a milestone ID into optional suffix and sequence number. */
export function parseMilestoneId(id: string): { suffix?: string; num: number } {
  const m = id.match(/^M(\d{3})(?:-([a-z0-9]{6}))?$/);
  if (!m) return { num: 0 };
  return {
    ...(m[2] ? { suffix: m[2] } : {}),
    num: parseInt(m[1], 10),
  };
}

// ─── Sorting ────────────────────────────────────────────────────────────────

/** Comparator for sorting milestone IDs by sequential number. */
export function milestoneIdSort(a: string, b: string): number {
  return extractMilestoneSeq(a) - extractMilestoneSeq(b);
}

// ─── Generation ─────────────────────────────────────────────────────────────

/** Generate a 6-char lowercase `[a-z0-9]` suffix using crypto.randomInt(). */
export function generateMilestoneSuffix(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < 6; i++) {
    result += chars[randomInt(36)];
  }
  return result;
}

/** Return the highest numeric suffix among milestone IDs (0 when the list is empty or has no numeric IDs). */
export function maxMilestoneNum(milestoneIds: string[]): number {
  return milestoneIds.reduce((max, id) => {
    const num = extractMilestoneSeq(id);
    return num > max ? num : max;
  }, 0);
}

/** Derive the next milestone ID from existing IDs using max-based approach to avoid collisions after deletions. */
export function nextMilestoneId(milestoneIds: string[], uniqueEnabled?: boolean): string {
  const seq = String(maxMilestoneNum(milestoneIds) + 1).padStart(3, "0");
  if (uniqueEnabled) {
    return `M${seq}-${generateMilestoneSuffix()}`;
  }
  return `M${seq}`;
}

// ─── Reservation ─────────────────────────────────────────────────────────────

/**
 * Module-level set of milestone IDs that have been previewed/promised to the
 * user but not yet materialised on disk. Both guided-flow (preview) and
 * gsd_milestone_generate_id (tool) share this set so the ID shown in the UI
 * matches the one the tool returns.
 */
const reservedMilestoneIds = new Set<string>();

/** Reserve an ID so that subsequent calls to `claimReservedId` / `nextMilestoneId` account for it. */
export function reserveMilestoneId(id: string): void {
  reservedMilestoneIds.add(id);
}

/**
 * If any IDs have been reserved, shift one out and return it.
 * Returns `undefined` when the reservation set is empty.
 */
export function claimReservedId(): string | undefined {
  const first = reservedMilestoneIds.values().next().value;
  if (first !== undefined) {
    reservedMilestoneIds.delete(first);
    return first;
  }
  return undefined;
}

/** Return a snapshot of all currently reserved IDs (for merging into the "existing" list). */
export function getReservedMilestoneIds(): ReadonlySet<string> {
  return reservedMilestoneIds;
}

/** Clear all reservations (useful for tests). */
export function clearReservedMilestoneIds(): void {
  reservedMilestoneIds.clear();
}

// ─── Discovery ──────────────────────────────────────────────────────────────

/** Scan the milestones directory and return IDs sorted by queue order (or numeric fallback). */
export function findMilestoneIds(basePath: string): string[] {
  const dir = milestonesDir(basePath);
  try {
    const ids = readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        const match = d.name.match(/^(M\d+(?:-[a-z0-9]{6})?)/);
        return match ? match[1] : null;
      })
      .filter((id): id is string => id !== null);

    // Apply custom queue order if available, else fall back to numeric sort
    const customOrder = loadQueueOrder(basePath);
    return sortByQueueOrder(ids, customOrder);
  } catch (err) {
    // Log why milestone scanning failed — silent [] here causes infinite loops (#456)
    if (existsSync(dir)) {
      logWarning("engine", `findMilestoneIds: .gsd/milestones/ exists but readdirSync failed — ${getErrorMessage(err)}`);
    }
    return [];
  }
}

// ─── Validation ─────────────────────────────────────────────────────────────

/** Discriminator for the kind of identifier that failed validation. */
export type InvalidIdKind = "milestone" | "slice" | "task" | "worktree-path";

/**
 * Thrown by the `assert*` validators below when an identifier or path fails
 * shape checks. Carries structured context so call-site loggers can emit
 * `{ source, attemptedId, kind }` for forensics without re-parsing the message.
 */
export class InvalidIdError extends Error {
  readonly kind: InvalidIdKind;
  readonly source: string;
  readonly attemptedId: string;

  constructor(kind: InvalidIdKind, source: string, attemptedId: string, message?: string) {
    super(message ?? `${kind} validation failed for ${JSON.stringify(attemptedId)} at ${source}`);
    this.name = "InvalidIdError";
    this.kind = kind;
    this.source = source;
    this.attemptedId = attemptedId;
  }
}

/** Stringify any input safely so we can include it in InvalidIdError without
 *  letting `null`/`undefined`/symbols crash JSON.stringify. */
function stringifyForError(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return value;
  try {
    return String(value);
  } catch {
    return "<unstringifiable>";
  }
}

/** Throw `InvalidIdError({kind:'milestone'})` if `id` is not a string matching `MILESTONE_ID_RE`. */
export function assertMilestoneId(id: string, source: string = "unknown"): void {
  if (typeof id !== "string" || !MILESTONE_ID_RE.test(id)) {
    throw new InvalidIdError("milestone", source, stringifyForError(id));
  }
}

/** Throw `InvalidIdError({kind:'slice'})` if `id` is not a string matching `SLICE_ID_RE`. */
export function assertSliceId(id: string, source: string = "unknown"): void {
  if (typeof id !== "string" || !SLICE_ID_RE.test(id)) {
    throw new InvalidIdError("slice", source, stringifyForError(id));
  }
}

/** Throw `InvalidIdError({kind:'task'})` if `id` is not a string matching `TASK_ID_RE`. */
export function assertTaskId(id: string, source: string = "unknown"): void {
  if (typeof id !== "string" || !TASK_ID_RE.test(id)) {
    throw new InvalidIdError("task", source, stringifyForError(id));
  }
}

/**
 * POSIX-strict validation of a milestone worktree path. Throws
 * `InvalidIdError({kind:'worktree-path'})` if the path is not an absolute,
 * normalised POSIX path whose basename is a valid milestone ID. Rejects:
 *   - non-string input
 *   - non-absolute paths (`./M001`)
 *   - un-normalised paths (`/foo//M001`, trailing `/`)
 *   - traversal segments (`/foo/../M001`) — checked via both `normalize()`
 *     and segment-split (belt-and-braces, since pre-normalised inputs can
 *     still hide `..` segments past the basename check)
 *   - NUL byte (`\0`)
 *   - backslash (treated as a path separator on Windows; rejected here as
 *     POSIX-only — Windows handling deferred to S05)
 *   - basename that is not a valid milestone ID
 */
export function assertWorktreePath(p: string, source: string = "unknown"): void {
  if (typeof p !== "string") {
    throw new InvalidIdError("worktree-path", source, stringifyForError(p));
  }
  if (p.includes("\0")) {
    throw new InvalidIdError("worktree-path", source, p);
  }
  if (p.includes("\\")) {
    throw new InvalidIdError("worktree-path", source, p);
  }
  if (!isAbsolute(p)) {
    throw new InvalidIdError("worktree-path", source, p);
  }
  if (normalize(p) !== p) {
    throw new InvalidIdError("worktree-path", source, p);
  }
  // node:path.normalize preserves trailing slashes — reject them so `${p}/sub`
  // never produces `//`-style joins downstream.
  if (p.length > 1 && p.endsWith("/")) {
    throw new InvalidIdError("worktree-path", source, p);
  }
  // Segment-split belt-and-braces: catches any `..` even if normalize() let it through.
  if (p.split("/").some((segment) => segment === "..")) {
    throw new InvalidIdError("worktree-path", source, p);
  }
  if (!MILESTONE_ID_RE.test(basename(p))) {
    throw new InvalidIdError("worktree-path", source, p);
  }
}

/**
 * Validate a worktree-local SQLite database path. Accepts any absolute POSIX
 * path that ends with `/.gsd/gsd.db` whose enclosing worktree root passes
 * `assertWorktreePath` (i.e. basename is a valid milestone ID). Throws
 * `InvalidIdError({kind:'worktree-path'})` on rejection — reusing the
 * existing discriminator (T03 decision: no new `'gsd-db-path'` kind because
 * the underlying contract is identical and forensics already expect
 * `'worktree-path'`).
 *
 * Used at the ATTACH DATABASE call site in `gsd-db.ts:reconcileWorktreeDb`
 * to replace the legacy weak `[';";\x00]` regex with a structural
 * allowlist that catches backslash, traversal, NUL, malformed worktree IDs,
 * and unexpected suffixes — anything an attacker could smuggle past the
 * old character class.
 *
 * Examples:
 *   assertGsdDbPath('/repo/.gsd/worktrees/M001/.gsd/gsd.db')   // ok
 *   assertGsdDbPath('/repo/.gsd/worktrees/M001-abc123/.gsd/gsd.db')  // ok
 *   assertGsdDbPath('/repo/.gsd/worktrees/M001/.gsd/other.db')  // throws (not gsd.db)
 *   assertGsdDbPath('/repo/.gsd/worktrees/notamilestone/.gsd/gsd.db')  // throws (basename not MILESTONE_ID_RE)
 *   assertGsdDbPath("/repo/.gsd/worktrees/M001'; ATTACH/.gsd/gsd.db")  // throws (basename invalid)
 */
const GSD_DB_SUFFIX = "/.gsd/gsd.db";

export function assertGsdDbPath(p: string, source: string = "unknown"): void {
  if (typeof p !== "string") {
    throw new InvalidIdError("worktree-path", source, stringifyForError(p));
  }
  // Up-front character checks before suffix slicing so a backslash in the
  // suffix region (e.g. `/foo/M001\\.gsd/gsd.db`) cannot be silently stripped.
  if (p.includes("\0") || p.includes("\\")) {
    throw new InvalidIdError("worktree-path", source, p);
  }
  if (!p.endsWith(GSD_DB_SUFFIX)) {
    throw new InvalidIdError("worktree-path", source, p);
  }
  const root = p.slice(0, -GSD_DB_SUFFIX.length);
  // Empty root means input was exactly "/.gsd/gsd.db" — reject (no worktree).
  if (root.length === 0) {
    throw new InvalidIdError("worktree-path", source, p);
  }
  // Delegate to assertWorktreePath for the absolute/normalize/traversal/
  // basename-MILESTONE_ID_RE checks against the stripped root. Re-throw with
  // the *original* full path as `attemptedId` so forensics see the value the
  // caller actually passed (not the stripped root) — `kind` and `source` are
  // preserved.
  try {
    assertWorktreePath(root, source);
  } catch (err) {
    if (err instanceof InvalidIdError) {
      throw new InvalidIdError(err.kind, err.source, p);
    }
    throw err;
  }
}
