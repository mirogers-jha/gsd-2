/**
 * M003/S03/T01 — D004 reproduce-and-prevent test for the worktree-name
 * git-option-injection vector at `worktree-command.ts:309` (handleCreate)
 * and `worktree-command.ts` (handleSwitch).
 *
 * Bug shape: a name like `--upload-pack=evil`, supplied via `/worktree create`
 * or the create-or-switch dispatcher, would flow into `git worktree add` argv
 * and be parsed by git as an option — RCE.
 *
 * Fix shape: `assertWorktreeName` (milestone-ids.ts) called BEFORE any path
 * or argv handling at both entry points. Throws `InvalidIdError({kind:
 * "worktree-name", source, attemptedId})`.
 *
 * Verification (per MEM012 D004 gate): comment-out / neutralise the
 * `assertWorktreeName` body and these tests must fail with the bug symptom
 * (the canonical injection strings no longer throw). Restore and confirm
 * green. The revert proof is captured in T01-SUMMARY.md verification table.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  InvalidIdError,
  assertWorktreeName,
} from "../milestone-ids.ts";

// ─── Canonical injection vector (the bug) ───────────────────────────────────

test("rejects the canonical git-option-injection name `--upload-pack=foo`", () => {
  assert.throws(
    () => assertWorktreeName("--upload-pack=foo", "test"),
    (err: unknown) =>
      err instanceof InvalidIdError &&
      err.kind === "worktree-name" &&
      err.source === "test" &&
      err.attemptedId === "--upload-pack=foo",
  );
});

test("rejects every leading-dash cousin git would parse as an option", () => {
  const cousins = [
    "-uX",
    "-x",
    "--exec=evil",
    "--",
    "-",
    "--no-checkout",
    "-b",
  ];
  for (const name of cousins) {
    assert.throws(
      () => assertWorktreeName(name, "test"),
      (err: unknown) =>
        err instanceof InvalidIdError &&
        err.kind === "worktree-name" &&
        err.attemptedId === name,
      `expected InvalidIdError(worktree-name) for ${JSON.stringify(name)}`,
    );
  }
});

// ─── Path-separator and NUL injection ───────────────────────────────────────

test("rejects forward-slash, backslash, NUL, and absolute-path names", () => {
  const bad = [
    "foo/bar",
    "foo\\bar",
    "foo\u0000bar",
    "/etc/passwd",
    "../escape",
  ];
  for (const name of bad) {
    assert.throws(
      () => assertWorktreeName(name, "test"),
      (err: unknown) =>
        err instanceof InvalidIdError && err.kind === "worktree-name",
      `expected throw for ${JSON.stringify(name)}`,
    );
  }
});

// ─── Empty / dot / dot-dot / non-string ─────────────────────────────────────

test("rejects empty string, `.`, `..`, and non-string input", () => {
  assert.throws(
    () => assertWorktreeName("", "test"),
    (err: unknown) =>
      err instanceof InvalidIdError && err.kind === "worktree-name",
  );
  assert.throws(
    () => assertWorktreeName(".", "test"),
    (err: unknown) =>
      err instanceof InvalidIdError && err.kind === "worktree-name",
  );
  assert.throws(
    () => assertWorktreeName("..", "test"),
    (err: unknown) =>
      err instanceof InvalidIdError && err.kind === "worktree-name",
  );
  // typeof guard fires before any string ops
  assert.throws(
    () => assertWorktreeName(null as unknown as string, "test"),
    (err: unknown) =>
      err instanceof InvalidIdError && err.kind === "worktree-name",
  );
  assert.throws(
    () => assertWorktreeName(undefined as unknown as string, "test"),
    (err: unknown) =>
      err instanceof InvalidIdError && err.kind === "worktree-name",
  );
  assert.throws(
    () => assertWorktreeName(123 as unknown as string, "test"),
    (err: unknown) =>
      err instanceof InvalidIdError && err.kind === "worktree-name",
  );
});

// ─── Shape regex: shell metas, leading underscore, whitespace ───────────────

test("rejects shape violations (shell metacharacters, leading `_`, whitespace)", () => {
  const bad = [
    "foo bar",
    "foo;rm",
    "foo`rm`",
    "foo|cat",
    "foo$bar",
    "foo&bg",
    "foo(eval)",
    "_leading",
    " leading",
  ];
  for (const name of bad) {
    assert.throws(
      () => assertWorktreeName(name, "test"),
      (err: unknown) =>
        err instanceof InvalidIdError && err.kind === "worktree-name",
      `expected throw for ${JSON.stringify(name)}`,
    );
  }
});

// ─── Acceptance: real, valid worktree names ─────────────────────────────────

test("accepts conventional milestone-ish and feature-ish names", () => {
  const good = [
    "M001",
    "M001-abc123",
    "feature_x",
    "wt_1",
    "0",
    "X",
    "release-2026-05",
  ];
  for (const name of good) {
    assert.doesNotThrow(
      () => assertWorktreeName(name, "test"),
      `expected acceptance for ${JSON.stringify(name)}`,
    );
  }
});

// ─── Forensic-source preservation ───────────────────────────────────────────

test("preserves source string on InvalidIdError for forensic loggers", () => {
  try {
    assertWorktreeName("--upload-pack=evil", "worktree-command:handleCreate");
    assert.fail("expected throw");
  } catch (err) {
    assert.ok(err instanceof InvalidIdError);
    assert.equal(err.kind, "worktree-name");
    assert.equal(err.source, "worktree-command:handleCreate");
    assert.equal(err.attemptedId, "--upload-pack=evil");
  }
});
