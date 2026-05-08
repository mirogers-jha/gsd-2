// Project/App: GSD-2
// File Purpose: Canonical retry-counter key encoder/decoder for auto-mode.
//
// Background (M002/S01/MEM042): the auto-mode retry counter has historically
// been keyed three different ways across read/write sites:
//   1. canonical:         `${type}:${id}`    e.g. "verify:M001/S01/T01"
//   2. legacy bare-id:    `${id}`            e.g. "M001/S01/T01"
//   3. legacy slash form: `${type}/${id}`    e.g. "verify/M001/S01/T01"
//
// New write sites must emit canonical only. Read sites continue to accept
// all three formats during the deprecation window so that pre-existing
// counters in `verification-retry-counts.json` are not silently dropped
// after upgrade. Direct-import only — do NOT re-export through `index.ts`.

/** Phase prefix for retry counters that share the "verify-and-retry" loop. */
export type RetryCounterType = "verify" | "uat" | "rewrite";

const RETRY_COUNTER_TYPES: ReadonlySet<string> = new Set<RetryCounterType>([
  "verify",
  "uat",
  "rewrite",
]);

/**
 * Build the canonical retry-counter key for a given phase + unit id.
 *
 * @throws TypeError when `type` is not one of the recognized phases or `id`
 *   is empty/non-string. We throw rather than returning a sentinel because
 *   write-site bugs are far more dangerous than read-site bugs — silently
 *   storing under a malformed key would leak retries into infinite loops.
 */
export function buildRetryCounterKey(type: RetryCounterType, id: string): string {
  if (typeof type !== "string" || !RETRY_COUNTER_TYPES.has(type)) {
    throw new TypeError(
      `buildRetryCounterKey: invalid type ${JSON.stringify(type)} (expected verify|uat|rewrite)`,
    );
  }
  if (typeof id !== "string" || id.length === 0) {
    throw new TypeError(
      `buildRetryCounterKey: id must be a non-empty string (got ${JSON.stringify(id)})`,
    );
  }
  return `${type}:${id}`;
}

/** Parsed shape returned by `parseRetryCounterKey`. */
export interface ParsedRetryCounterKey {
  type: RetryCounterType;
  id: string;
}

/**
 * Parse a retry-counter key in any of the three supported formats.
 * Returns `null` for malformed input (so callers can safely skip orphaned
 * entries without aborting hydration). Throws only on null/undefined or
 * non-string input — those represent caller bugs, not data corruption.
 *
 * Format precedence:
 *   1. canonical `${type}:${id}` — split on first ":" only (id may contain "/").
 *   2. legacy `${type}/${id}` — split on first "/" only when the head is a
 *      known type. We must check this BEFORE bare-id because "verify/M001/..."
 *      is a valid bare-id-shaped string under permissive parsing.
 *   3. legacy bare-id — anything matching the M###/S##/T## (or shorter)
 *      shape is treated as a `verify` counter for backward compatibility.
 */
export function parseRetryCounterKey(raw: string): ParsedRetryCounterKey | null {
  if (typeof raw !== "string") {
    throw new TypeError(
      `parseRetryCounterKey: expected string, got ${raw === null ? "null" : typeof raw}`,
    );
  }
  if (raw.length === 0) {
    throw new TypeError("parseRetryCounterKey: input must be non-empty");
  }

  // Canonical: `${type}:${id}` — only split on first ":" so ids containing
  // ":" round-trip (none today, but the contract is "id is opaque after the
  // first separator").
  const colonIdx = raw.indexOf(":");
  if (colonIdx > 0) {
    const head = raw.slice(0, colonIdx);
    const tail = raw.slice(colonIdx + 1);
    if (RETRY_COUNTER_TYPES.has(head) && tail.length > 0 && isUnitIdShape(tail)) {
      return { type: head as RetryCounterType, id: tail };
    }
    // Falls through — a colon in something other than a known type means
    // malformed input (the bare-id grammar disallows ":").
    return null;
  }

  // Legacy `${type}/${id}` — head must be a known type.
  const slashIdx = raw.indexOf("/");
  if (slashIdx > 0) {
    const head = raw.slice(0, slashIdx);
    const tail = raw.slice(slashIdx + 1);
    if (RETRY_COUNTER_TYPES.has(head) && tail.length > 0 && isUnitIdShape(tail)) {
      return { type: head as RetryCounterType, id: tail };
    }
    // Otherwise fall through to bare-id check — "M001/S01/T01" has slashes
    // but the head is "M001", not a known type.
  }

  // Legacy bare-id — assumed to be a `verify` counter.
  if (isUnitIdShape(raw)) {
    return { type: "verify", id: raw };
  }

  return null;
}

/**
 * Validate that `id` looks like an auto-mode unit identifier:
 *   - milestone alone:           M001, M001-abc123
 *   - milestone/slice:           M001/S01
 *   - milestone/slice/task:      M001/S01/T01
 * The unique-suffix milestone form (M###-xxxxxx) is accepted to match
 * `MILESTONE_ID_RE` in `milestone-ids.ts`.
 */
function isUnitIdShape(id: string): boolean {
  return /^M\d{3}(?:-[a-z0-9]{6})?(?:\/S\d{2}(?:\/T\d{2})?)?$/.test(id);
}
