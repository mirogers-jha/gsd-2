import test from "node:test";
import assert from "node:assert/strict";
import {
  buildRetryCounterKey,
  parseRetryCounterKey,
} from "../auto/retry-counter-key.ts";

// ─── buildRetryCounterKey ──────────────────────────────────────────────────

test("buildRetryCounterKey emits canonical for verify", () => {
  assert.equal(buildRetryCounterKey("verify", "M001/S01/T01"), "verify:M001/S01/T01");
});

test("buildRetryCounterKey emits canonical for uat", () => {
  assert.equal(buildRetryCounterKey("uat", "M001/S01"), "uat:M001/S01");
});

test("buildRetryCounterKey emits canonical for rewrite", () => {
  assert.equal(buildRetryCounterKey("rewrite", "M001"), "rewrite:M001");
});

test("buildRetryCounterKey accepts milestones with unique-suffix", () => {
  assert.equal(
    buildRetryCounterKey("verify", "M001-abc123/S01/T01"),
    "verify:M001-abc123/S01/T01",
  );
});

test("buildRetryCounterKey throws on unknown type", () => {
  assert.throws(
    // @ts-expect-error - exercising the runtime guard for the legacy union
    () => buildRetryCounterKey("recover", "M001/S01/T01"),
    /invalid type/,
  );
});

test("buildRetryCounterKey throws on non-string type", () => {
  assert.throws(
    // @ts-expect-error - guard runs before TS would catch this in JS callers
    () => buildRetryCounterKey(undefined, "M001/S01/T01"),
    /invalid type/,
  );
});

test("buildRetryCounterKey throws on empty id", () => {
  assert.throws(() => buildRetryCounterKey("verify", ""), /non-empty string/);
});

test("buildRetryCounterKey throws on non-string id", () => {
  assert.throws(
    // @ts-expect-error - guard runs before TS would catch this in JS callers
    () => buildRetryCounterKey("verify", null),
    /non-empty string/,
  );
});

// ─── parseRetryCounterKey: canonical ───────────────────────────────────────

test("parseRetryCounterKey parses canonical verify key", () => {
  assert.deepEqual(parseRetryCounterKey("verify:M001/S01/T01"), {
    type: "verify",
    id: "M001/S01/T01",
  });
});

test("parseRetryCounterKey parses canonical uat key", () => {
  assert.deepEqual(parseRetryCounterKey("uat:M001/S01"), {
    type: "uat",
    id: "M001/S01",
  });
});

test("parseRetryCounterKey parses canonical rewrite key", () => {
  assert.deepEqual(parseRetryCounterKey("rewrite:M001"), {
    type: "rewrite",
    id: "M001",
  });
});

test("parseRetryCounterKey parses canonical with unique-suffix milestone", () => {
  assert.deepEqual(parseRetryCounterKey("verify:M001-abc123/S01/T01"), {
    type: "verify",
    id: "M001-abc123/S01/T01",
  });
});

// ─── parseRetryCounterKey: legacy ${type}/${id} ────────────────────────────

test("parseRetryCounterKey parses legacy verify/<id>", () => {
  assert.deepEqual(parseRetryCounterKey("verify/M001/S01/T01"), {
    type: "verify",
    id: "M001/S01/T01",
  });
});

test("parseRetryCounterKey parses legacy uat/<id>", () => {
  assert.deepEqual(parseRetryCounterKey("uat/M001/S01"), {
    type: "uat",
    id: "M001/S01",
  });
});

test("parseRetryCounterKey parses legacy rewrite/<id>", () => {
  assert.deepEqual(parseRetryCounterKey("rewrite/M001"), {
    type: "rewrite",
    id: "M001",
  });
});

// ─── parseRetryCounterKey: legacy bare-id ──────────────────────────────────

test("parseRetryCounterKey treats bare task-id as verify", () => {
  assert.deepEqual(parseRetryCounterKey("M001/S01/T01"), {
    type: "verify",
    id: "M001/S01/T01",
  });
});

test("parseRetryCounterKey treats bare slice-id as verify", () => {
  assert.deepEqual(parseRetryCounterKey("M001/S01"), {
    type: "verify",
    id: "M001/S01",
  });
});

test("parseRetryCounterKey treats bare milestone-id as verify", () => {
  assert.deepEqual(parseRetryCounterKey("M001"), {
    type: "verify",
    id: "M001",
  });
});

test("parseRetryCounterKey accepts unique-suffix bare-id", () => {
  assert.deepEqual(parseRetryCounterKey("M001-abc123/S01/T01"), {
    type: "verify",
    id: "M001-abc123/S01/T01",
  });
});

// ─── parseRetryCounterKey: malformed ───────────────────────────────────────

test("parseRetryCounterKey returns null for unknown type prefix on canonical", () => {
  assert.equal(parseRetryCounterKey("recover:M001/S01/T01"), null);
});

test("parseRetryCounterKey returns null for canonical with empty id", () => {
  assert.equal(parseRetryCounterKey("verify:"), null);
});

test("parseRetryCounterKey returns null for canonical with malformed id", () => {
  assert.equal(parseRetryCounterKey("verify:not-a-unit"), null);
});

test("parseRetryCounterKey returns null for legacy slash with unknown type", () => {
  // "x/M001/S01/T01" — head "x" is not a known type and not a milestone shape.
  assert.equal(parseRetryCounterKey("x/M001/S01/T01"), null);
});

test("parseRetryCounterKey returns null for arbitrary garbage", () => {
  assert.equal(parseRetryCounterKey("hello world"), null);
});

test("parseRetryCounterKey returns null for lowercase milestone", () => {
  assert.equal(parseRetryCounterKey("m001/s01/t01"), null);
});

test("parseRetryCounterKey returns null for over-long unit path", () => {
  assert.equal(parseRetryCounterKey("M001/S01/T01/extra"), null);
});

// ─── parseRetryCounterKey: input-shape errors ──────────────────────────────

test("parseRetryCounterKey throws on empty string", () => {
  assert.throws(() => parseRetryCounterKey(""), /non-empty/);
});

test("parseRetryCounterKey throws on null", () => {
  assert.throws(
    // @ts-expect-error - exercising the runtime guard
    () => parseRetryCounterKey(null),
    /expected string/,
  );
});

test("parseRetryCounterKey throws on undefined", () => {
  assert.throws(
    // @ts-expect-error - exercising the runtime guard
    () => parseRetryCounterKey(undefined),
    /expected string/,
  );
});

test("parseRetryCounterKey throws on number", () => {
  assert.throws(
    // @ts-expect-error - exercising the runtime guard
    () => parseRetryCounterKey(42),
    /expected string/,
  );
});

// ─── round-trip ────────────────────────────────────────────────────────────

test("buildRetryCounterKey + parseRetryCounterKey round-trip for all types", () => {
  for (const type of ["verify", "uat", "rewrite"] as const) {
    const id = "M042/S03/T07";
    const key = buildRetryCounterKey(type, id);
    assert.deepEqual(parseRetryCounterKey(key), { type, id });
  }
});
