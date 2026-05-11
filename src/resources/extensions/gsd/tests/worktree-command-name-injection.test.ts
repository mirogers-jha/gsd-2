/**
 * worktree-command-name-injection.test.ts
 *
 * D004 reproduce-and-prevent for M003/S03/T01 (Bug 1).
 *
 * Bug (HIGH-severity, FIXED-candidate per .bugs/bug-list.md): the
 * `/worktree create <name>` flow validated `name` only at
 * `worktree-manager.ts:229` via the inline regex `/^[a-zA-Z0-9_-]+$/`.
 * That regex accepts `--upload-pack=foo` (and `-uX`, `-anything`) — the
 * leading `-` slips through, so the malicious name is appended to
 * `git worktree add` argv as a flag instead of a positional argument.
 * `git` then interprets `--upload-pack=…` as a transport hook and runs
 * arbitrary shell.
 *
 * Fix (T01):
 *   1. New `assertWorktreeName` validator in `milestone-ids.ts`
 *      (kind: 'worktree-name') tightens the contract — first char MUST be
 *      alphanumeric, separators (`/`, `\`), NUL, `.`, `..`, and empty
 *      strings are rejected.
 *   2. `worktree-command.ts` calls `assertWorktreeName` BEFORE
 *      `createWorktree` in `handleCreate`, AND at the top of
 *      `handleSwitch` (defense in depth — `handleSwitch` is reachable
 *      from raw user input via `/worktree switch <name>`).
 *
 * The existing inline regex at `worktree-manager.ts:229` is INTENTIONALLY
 * left in place as defense-in-depth (R014: no refactor). Internal
 * `createWorktree` callers that bypass the command layer still get the
 * old narrower check.
 *
 * RED proof (pre-fix): comment out the `assertWorktreeName` call inside
 * `handleCreate` (or revert the validator export) and the
 * `--upload-pack=foo` assertion below fails (validator throws → caught,
 * but with `assertWorktreeName` removed nothing throws and the malicious
 * name reaches `createWorktree`'s inline regex which ACCEPTS `-uX`,
 * `-anything-without-equals`, etc.).
 *
 * GREEN proof (post-fix): every malicious name throws `InvalidIdError`
 * with `kind === 'worktree-name'` and the offending input preserved on
 * `error.attemptedId`.
 *
 * Direct-import per MEM009/MEM011 — no barrel; relative `.ts` extensions.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  assertWorktreeName,
  InvalidIdError,
} from "../milestone-ids.ts";

describe("assertWorktreeName — git option-injection rejection (M003/S03/T01)", () => {
  test("rejects --upload-pack=foo (canonical injection vector)", () => {
    assert.throws(
      () => assertWorktreeName("--upload-pack=foo", "test"),
      (err: unknown) => {
        assert.ok(err instanceof InvalidIdError, "expected InvalidIdError");
        assert.equal(err.kind, "worktree-name");
        assert.equal(err.attemptedId, "--upload-pack=foo");
        assert.equal(err.source, "test");
        return true;
      },
    );
  });

  test("rejects every leading-dash cousin", () => {
    const malicious = ["-uX", "-x", "--exec=evil", "--", "-"];
    for (const name of malicious) {
      assert.throws(
        () => assertWorktreeName(name, "test"),
        (err: unknown) => err instanceof InvalidIdError && err.kind === "worktree-name",
        `expected ${JSON.stringify(name)} to throw InvalidIdError(kind:'worktree-name')`,
      );
    }
  });

  test("rejects path-separator and NUL injection", () => {
    const malicious = ["foo/bar", "foo\\bar", "foo\u0000bar", "/etc/passwd"];
    for (const name of malicious) {
      assert.throws(
        () => assertWorktreeName(name, "test"),
        (err: unknown) => err instanceof InvalidIdError && err.kind === "worktree-name",
        `expected ${JSON.stringify(name)} to throw InvalidIdError(kind:'worktree-name')`,
      );
    }
  });

  test("rejects empty / dot / dot-dot / non-string", () => {
    assert.throws(() => assertWorktreeName("", "test"), InvalidIdError);
    assert.throws(() => assertWorktreeName(".", "test"), InvalidIdError);
    assert.throws(() => assertWorktreeName("..", "test"), InvalidIdError);
    // typeof guard
    assert.throws(
      () => assertWorktreeName(undefined as unknown as string, "test"),
      InvalidIdError,
    );
    assert.throws(
      () => assertWorktreeName(null as unknown as string, "test"),
      InvalidIdError,
    );
  });

  test("rejects names that fail the final shape regex (e.g. spaces, punctuation)", () => {
    const malicious = ["foo bar", "foo.bar", "foo;rm", "foo`rm`", "foo$x", "_leading"];
    for (const name of malicious) {
      assert.throws(
        () => assertWorktreeName(name, "test"),
        (err: unknown) => err instanceof InvalidIdError && err.kind === "worktree-name",
        `expected ${JSON.stringify(name)} to throw`,
      );
    }
  });

  test("accepts valid worktree names", () => {
    const valid = ["M001", "M001-abc123", "feature-x", "feature_x", "wt_1", "a-b", "X", "0"];
    for (const name of valid) {
      assert.doesNotThrow(
        () => assertWorktreeName(name, "test"),
        `expected ${JSON.stringify(name)} to be accepted`,
      );
    }
  });

  test("error carries source for forensic logging", () => {
    try {
      assertWorktreeName("--upload-pack=foo", "worktree-command:handleCreate");
      assert.fail("expected throw");
    } catch (err) {
      assert.ok(err instanceof InvalidIdError);
      assert.equal(err.source, "worktree-command:handleCreate");
      assert.equal(err.kind, "worktree-name");
      assert.equal(err.attemptedId, "--upload-pack=foo");
    }
  });
});
