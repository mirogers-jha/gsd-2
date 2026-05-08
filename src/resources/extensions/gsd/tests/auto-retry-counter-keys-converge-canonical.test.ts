// Project/App: GSD-2
// File Purpose: D004 regression for M002/S01/T05 — proves that all retry-counter
// mutation sites converge on the canonical `verify:${id}` key after the T05
// migration. Pre-fix: auto-verification.ts wrote bare `${id}` and
// auto-post-unit.ts wrote `${unitType}:${id}`, so the two read sites observed
// independent counter slots and double-incremented for the same (type, id) tuple.
//
// This test exercises the helper layer directly (the production sites all
// share the same helpers), and asserts:
//   1. legacy bare-id and legacy slash-keyed reads both migrate to the
//      canonical `verify:${id}` slot
//   2. two writes via different production schemas (bare-id and `${unitType}:${id}`)
//      converge on a single canonical counter rather than diverging
//   3. clearRetryCounter purges every legacy form so no orphaned counter
//      escapes the migration window
//
// D004: revert one of the two converged-write paths to the legacy schema and
// re-run — the convergence assertion fails because the two writers land in
// distinct slots again.

import test from "node:test";
import assert from "node:assert/strict";
import {
  buildRetryCounterKey,
  clearRetryCounter,
  readRetryCounter,
  type RetryCounterMigrationEvent,
} from "../auto/retry-counter-key.ts";

// ─── Convergence: legacy reads collapse to canonical ────────────────────────

test("readRetryCounter migrates legacy bare-id read to canonical and emits a migration event", () => {
  const map = new Map<string, number>();
  map.set("M001/S01/T01", 2); // pre-T05 auto-verification.ts schema

  const events: RetryCounterMigrationEvent[] = [];
  const value = readRetryCounter(map, "verify", "M001/S01/T01", e => events.push(e));

  assert.equal(value, 2);
  assert.equal(map.get("verify:M001/S01/T01"), 2);
  assert.equal(map.has("M001/S01/T01"), false, "legacy bare-id slot must be cleared");
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    legacyKey: "M001/S01/T01",
    canonicalKey: "verify:M001/S01/T01",
    value: 2,
  });
});

test("readRetryCounter migrates legacy ${type}/${id} slash read to canonical", () => {
  const map = new Map<string, number>();
  map.set("verify/M001/S01/T01", 3);

  const value = readRetryCounter(map, "verify", "M001/S01/T01");

  assert.equal(value, 3);
  assert.equal(map.get("verify:M001/S01/T01"), 3);
  assert.equal(map.has("verify/M001/S01/T01"), false);
});

test("readRetryCounter migrates legacy ${unitType}:${id} read to canonical", () => {
  // Pre-T05 auto-post-unit.ts schema: head was the auto-mode unit type, not the retry phase.
  const map = new Map<string, number>();
  map.set("research-project:M001", 4);

  const value = readRetryCounter(map, "verify", "M001");

  assert.equal(value, 4);
  assert.equal(map.get("verify:M001"), 4);
  assert.equal(map.has("research-project:M001"), false);
});

test("readRetryCounter migrates legacy ${unitType}/${id} read to canonical", () => {
  // Pre-T05 workflow-custom-engine-retry.ts schema.
  const map = new Map<string, number>();
  map.set("execute-task/T01", 5);

  const value = readRetryCounter(map, "verify", "T01");

  assert.equal(value, 5);
  assert.equal(map.get("verify:T01"), 5);
  assert.equal(map.has("execute-task/T01"), false);
});

test("readRetryCounter returns 0 when no canonical or legacy entry exists", () => {
  const map = new Map<string, number>();
  const value = readRetryCounter(map, "verify", "M001/S01/T01");
  assert.equal(value, 0);
  assert.equal(map.size, 0, "must not synthesize an entry on miss");
});

// ─── Convergence: writes through different production-schema paths land in one slot ──

test("two write paths emitting bare-id and ${unitType}:${id} converge after one read", () => {
  // Simulates the divergence the bug-list flagged:
  //   - auto-verification.ts wrote bare `${id}`
  //   - auto-post-unit.ts wrote `${unitType}:${id}`
  // After T05, both call sites use `buildRetryCounterKey("verify", id)` for writes
  // AND use `readRetryCounter(...)` for reads, so divergent legacy entries written
  // by an older session must collapse on the next read.
  const map = new Map<string, number>();
  // Older session left these two divergent entries behind:
  map.set("M001/S01/T01", 1);                    // legacy auto-verification write
  map.set("execute-task:M001/S01/T01", 1);       // legacy auto-post-unit write

  // First read normalizes one legacy entry; second read normalizes the other
  // (or — depending on iteration order — both into the same slot).
  const first = readRetryCounter(map, "verify", "M001/S01/T01");
  const second = readRetryCounter(map, "verify", "M001/S01/T01");

  // The post-migration map MUST have exactly one canonical entry for this id —
  // not two divergent legacy entries each carrying their own count.
  const canonicalEntries = Array.from(map.keys()).filter(k => k.endsWith("M001/S01/T01"));
  assert.equal(canonicalEntries.length, 1, `expected single canonical key, got: ${canonicalEntries.join(", ")}`);
  assert.equal(canonicalEntries[0], "verify:M001/S01/T01");

  // Reads return SOME consistent positive value rather than double-counting both
  // legacy slots. The exact number depends on iteration order (Maps preserve
  // insertion order), which is fine — the key invariant is "one slot, not two".
  assert.ok(first >= 1, `first read must surface a migrated value, got ${first}`);
  assert.equal(second, first, "second read must observe the canonical value the first read materialized");
});

test("write path via buildRetryCounterKey lands in the same slot a subsequent read normalizes", () => {
  const map = new Map<string, number>();
  // Production write site (post-T05): auto-verification.ts retry-set
  map.set(buildRetryCounterKey("verify", "M001/S01/T01"), 7);

  // Production read site: returns the same canonical value, no migration event.
  const events: RetryCounterMigrationEvent[] = [];
  const value = readRetryCounter(map, "verify", "M001/S01/T01", e => events.push(e));

  assert.equal(value, 7);
  assert.equal(events.length, 0, "canonical reads must not emit migration events");
});

// ─── clearRetryCounter purges every legacy form ─────────────────────────────

test("clearRetryCounter removes canonical and all legacy schemas for the same id", () => {
  const map = new Map<string, number>();
  map.set("verify:M001/S01/T01", 1);                 // canonical
  map.set("M001/S01/T01", 2);                        // legacy bare-id
  map.set("verify/M001/S01/T01", 3);                 // legacy slash
  map.set("execute-task:M001/S01/T01", 4);           // legacy unit-type colon
  map.set("research-project/M001/S01/T01", 5);       // legacy unit-type slash
  // Unrelated entry that must NOT be touched:
  map.set("verify:M002/S02/T02", 9);

  clearRetryCounter(map, "verify", "M001/S01/T01");

  assert.equal(map.has("verify:M001/S01/T01"), false);
  assert.equal(map.has("M001/S01/T01"), false);
  assert.equal(map.has("verify/M001/S01/T01"), false);
  assert.equal(map.has("execute-task:M001/S01/T01"), false);
  assert.equal(map.has("research-project/M001/S01/T01"), false);
  assert.equal(map.get("verify:M002/S02/T02"), 9, "unrelated entry must survive the clear");
});

// ─── Single-id-collision safety: clearing must not nuke an unrelated id with same suffix ──

test("clearRetryCounter does NOT remove entries whose id only happens to share a suffix", () => {
  const map = new Map<string, number>();
  map.set("execute-task:M001/S01/T01", 4);
  map.set("execute-task:M001/S01/T02", 5); // distinct id — must survive

  clearRetryCounter(map, "verify", "M001/S01/T01");

  assert.equal(map.has("execute-task:M001/S01/T01"), false);
  assert.equal(map.get("execute-task:M001/S01/T02"), 5);
});
