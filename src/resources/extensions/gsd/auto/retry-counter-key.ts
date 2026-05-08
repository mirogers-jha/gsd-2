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

// ─── Map-aware read/clear helpers (T05 migration window) ───────────────────
//
// Read sites must accept canonical, legacy bare-id, and legacy `${type}/${id}`
// formats during the one-milestone deprecation window. The helpers below take
// the in-memory `verificationRetryCount` Map and a (type, id) tuple, look up
// the value under all known formats, and (when reading) migrate any legacy
// hit to canonical so subsequent reads/writes converge.
//
// `onLegacyMigrated` lets call sites surface a `logWarning` without coupling
// this module to `workflow-logger.ts` — keeps the helper pure/testable.

export interface RetryCounterMigrationEvent {
  /** Legacy key that was found in the map. */
  legacyKey: string;
  /** Canonical key the value was migrated to. */
  canonicalKey: string;
  /** Counter value preserved across the migration. */
  value: number;
}

/**
 * Resolve the value of a retry counter, accepting legacy keys.
 *
 * Lookup order (first hit wins):
 *   1. canonical `${type}:${id}`
 *   2. legacy `${type}/${id}` (slash variant, used by workflow-custom-engine)
 *   3. legacy bare `${id}` (only when type === "verify"; bare keys had no phase)
 *
 * On legacy hit the value is migrated to the canonical slot and the legacy
 * entry is deleted, so subsequent operations converge. Returns 0 when no
 * key is present.
 */
export function readRetryCounter(
  map: Map<string, number>,
  type: RetryCounterType,
  id: string,
  onLegacyMigrated?: (event: RetryCounterMigrationEvent) => void,
): number {
  const canonical = buildRetryCounterKey(type, id);

  // Collect every key in the map that refers to the same (type, id) tuple
  // under any known schema, then merge them all into the canonical slot. We
  // use Math.max as the merge function because retry counters are monotonic
  // attempt counts — taking the largest preserves the worst-case circuit
  // breaker state, which is the safer-for-correctness choice (sum would
  // double-count; min would forget retries already burned).
  let merged: number | undefined = undefined;
  if (typeof map.get(canonical) === "number") {
    merged = map.get(canonical);
  }

  // Phase-keyed legacy: `${type}/${id}` (slash variant) and bare `${id}` for verify.
  const phaseLegacyKeys: string[] = [`${type}/${id}`];
  if (type === "verify") {
    phaseLegacyKeys.push(id);
  }
  for (const legacyKey of phaseLegacyKeys) {
    const value = map.get(legacyKey);
    if (typeof value !== "number") continue;
    merged = merged === undefined ? value : Math.max(merged, value);
    map.delete(legacyKey);
    onLegacyMigrated?.({ legacyKey, canonicalKey: canonical, value });
  }

  // Pre-T05 schemas where the head is an auto-mode UNIT TYPE
  // (research-project, execute-task, complete-milestone, ...) — separator was
  // either ":" (auto-post-unit) or "/" (workflow-custom-engine). Only swept
  // for `type === "verify"` because uat/rewrite never used unit-type heads.
  if (type === "verify") {
    for (const existingKey of Array.from(map.keys())) {
      if (existingKey === canonical) continue;
      const c = existingKey.indexOf(":");
      const sl = existingKey.indexOf("/");
      const sepIdx = c < 0 ? sl : sl < 0 ? c : Math.min(c, sl);
      if (sepIdx <= 0) continue;
      const head = existingKey.slice(0, sepIdx);
      const tail = existingKey.slice(sepIdx + 1);
      if (tail !== id) continue;
      if (RETRY_COUNTER_TYPES.has(head)) continue; // phase-keyed — already considered above
      const value = map.get(existingKey);
      if (typeof value !== "number") continue;
      merged = merged === undefined ? value : Math.max(merged, value);
      map.delete(existingKey);
      onLegacyMigrated?.({ legacyKey: existingKey, canonicalKey: canonical, value });
    }
  }

  if (merged === undefined) {
    return 0;
  }
  // Materialize the canonical slot exactly once — even when the value came
  // straight from an existing canonical entry — so callers get a stable shape.
  map.set(canonical, merged);
  return merged;
}

/**
 * Delete a retry counter under the canonical key AND any legacy key variants.
 * Used by the many "clear retries on success" sites that previously deleted
 * only one schema and so left orphaned counters under the other.
 */
export function clearRetryCounter(
  map: Map<string, number>,
  type: RetryCounterType,
  id: string,
): void {
  map.delete(buildRetryCounterKey(type, id));
  map.delete(`${type}/${id}`);
  if (type === "verify") {
    map.delete(id);
    // Also drop pre-T05 `${unitType}<sep>${id}` entries that share the same id
    // (sep ∈ ":" | "/"). See `readRetryCounter` for the migration rationale.
    for (const existingKey of Array.from(map.keys())) {
      const c = existingKey.indexOf(":");
      const sl = existingKey.indexOf("/");
      const sepIdx = c < 0 ? sl : sl < 0 ? c : Math.min(c, sl);
      if (sepIdx <= 0) continue;
      const head = existingKey.slice(0, sepIdx);
      const tail = existingKey.slice(sepIdx + 1);
      if (tail === id && !RETRY_COUNTER_TYPES.has(head)) {
        map.delete(existingKey);
      }
    }
  }
}
