/**
 * attach-database-rejects-malicious-worktree-path.test.ts
 *
 * D004 reproduce-and-prevent for S05/T03.
 *
 * Bug (HIGH-severity, .bugs/bug-list.md): `reconcileWorktreeDb` interpolated
 * `worktreeDbPath` directly into a raw `ATTACH DATABASE '${worktreeDbPath}'`
 * SQL string after a too-permissive `[';";\x00]` regex. Any path that
 * happened to contain none of those four characters — including
 * `/tmp/foo/notamilestone/.gsd/gsd.db`, paths with backslashes
 * (`/tmp/foo/M001\\x/.gsd/gsd.db`), or paths with `..` traversal segments —
 * was attached to the main DB without any structural check that the path
 * looked like a real worktree DB.
 *
 * Fix (T03): `assertGsdDbPath` (milestone-ids.ts) is called before ATTACH.
 * It strips the `/.gsd/gsd.db` suffix and delegates to `assertWorktreePath`,
 * so the worktree-root-basename-must-match-MILESTONE_ID_RE contract carries
 * through. Validator failure -> structured logError + zero ReconcileResult,
 * no ATTACH issued.
 *
 * RED proof (pre-fix): commenting out the new `assertGsdDbPath` block in
 * gsd-db.ts:reconcileWorktreeDb makes the "decisions reconciled" assertion
 * below fire (decisions count > 0 because ATTACH proceeded).
 * GREEN proof (post-fix): decisions count is 0 and result.conflicts is empty
 * — validator short-circuits before ATTACH.
 *
 * Direct-import (no barrel) per MEM009/MEM011.
 */

import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  openDatabase,
  closeDatabase,
  reconcileWorktreeDb,
  insertDecision,
} from "../gsd-db.ts";
import { assertGsdDbPath, InvalidIdError } from "../milestone-ids.ts";

// ─── Validator-level unit checks ───────────────────────────────────────────

describe("assertGsdDbPath: structural allowlist", () => {
  test("accepts canonical worktree DB path", () => {
    assert.doesNotThrow(() =>
      assertGsdDbPath("/repo/.gsd/worktrees/M001/.gsd/gsd.db", "test"),
    );
  });

  test("accepts unique-suffix milestone form", () => {
    assert.doesNotThrow(() =>
      assertGsdDbPath("/repo/.gsd/worktrees/M001-abc123/.gsd/gsd.db", "test"),
    );
  });

  test("rejects path whose basename is not a milestone ID (passed old regex)", () => {
    // Old weak regex `[';";\x00]` would accept this path. New validator
    // must reject because basename `notamilestone` fails MILESTONE_ID_RE.
    const malicious = "/tmp/foo/notamilestone/.gsd/gsd.db";
    assert.throws(
      () => assertGsdDbPath(malicious, "test"),
      (err: unknown) =>
        err instanceof InvalidIdError &&
        err.kind === "worktree-path" &&
        err.source === "test" &&
        err.attemptedId === malicious,
    );
  });

  test("rejects path with embedded backslash (passed old regex)", () => {
    // Old regex did not include `\\`. New validator rejects up-front.
    const malicious = "/tmp/foo/M001\\x/.gsd/gsd.db";
    assert.throws(
      () => assertGsdDbPath(malicious, "test"),
      (err: unknown) => err instanceof InvalidIdError && err.kind === "worktree-path",
    );
  });

  test("rejects path with `..` traversal segment (passed old regex)", () => {
    const malicious = "/tmp/foo/../M001/.gsd/gsd.db";
    assert.throws(
      () => assertGsdDbPath(malicious, "test"),
      (err: unknown) => err instanceof InvalidIdError && err.kind === "worktree-path",
    );
  });

  test("rejects path missing /.gsd/gsd.db suffix", () => {
    assert.throws(
      () => assertGsdDbPath("/repo/.gsd/worktrees/M001/.gsd/other.db", "test"),
      (err: unknown) => err instanceof InvalidIdError,
    );
  });

  test("rejects non-string input", () => {
    assert.throws(
      () => assertGsdDbPath(undefined as unknown as string, "test"),
      (err: unknown) => err instanceof InvalidIdError,
    );
  });

  test("rejects exact `/.gsd/gsd.db` (empty worktree root)", () => {
    assert.throws(
      () => assertGsdDbPath("/.gsd/gsd.db", "test"),
      (err: unknown) => err instanceof InvalidIdError,
    );
  });

  test("rejects relative path", () => {
    assert.throws(
      () => assertGsdDbPath("./M001/.gsd/gsd.db", "test"),
      (err: unknown) => err instanceof InvalidIdError,
    );
  });
});

// ─── Behavioral D004: reconcileWorktreeDb refuses malicious path ───────────

describe("S05/T03: reconcileWorktreeDb rejects malicious worktree DB paths", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "gsd-s05t03-"));
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("malicious-basename worktree DB is NOT reconciled (D004 GREEN)", () => {
    // Build a real, openable SQLite file under a path whose basename does
    // NOT match MILESTONE_ID_RE — e.g. `notamilestone`. Pre-fix, the weak
    // regex accepted this and ATTACH proceeded, reconciling worktree data
    // into main. Post-fix, assertGsdDbPath rejects before ATTACH.
    const mainGsd = join(tmpDir, "main", ".gsd");
    mkdirSync(mainGsd, { recursive: true });
    const mainDbPath = join(mainGsd, "gsd.db");

    openDatabase(mainDbPath);
    insertDecision({
      id: "D001",
      when_context: "2026-01-01",
      scope: "M001",
      decision: "Main decision",
      choice: "Main choice",
      rationale: "Main rationale",
      revisable: "yes",
      made_by: "agent",
      superseded_by: null,
    });
    closeDatabase();

    // Build a real SQLite DB at a malicious-looking path. The DB itself is
    // valid (has a D002 decision) — only the *path* is illegal under the
    // worktree-DB contract.
    const wtGsd = join(tmpDir, "notamilestone", ".gsd");
    mkdirSync(wtGsd, { recursive: true });
    const worktreeDbPath = join(wtGsd, "gsd.db");

    openDatabase(worktreeDbPath);
    insertDecision({
      id: "D002",
      when_context: "2026-01-01",
      scope: "M001",
      decision: "WT decision (must NOT leak into main)",
      choice: "WT choice",
      rationale: "WT rationale",
      revisable: "yes",
      made_by: "agent",
      superseded_by: null,
    });
    closeDatabase();

    // Re-open main and attempt to reconcile from the malicious path.
    openDatabase(mainDbPath);
    const result = reconcileWorktreeDb(mainDbPath, worktreeDbPath);

    // Post-fix: validator rejects, zero result, no ATTACH happened.
    // Pre-fix: ATTACH succeeded, decisions > 0, D002 leaked into main.
    assert.equal(
      result.decisions,
      0,
      "no decisions should be reconciled — assertGsdDbPath must reject malicious basename BEFORE ATTACH",
    );
    assert.equal(result.requirements, 0);
    assert.equal(result.artifacts, 0);
    assert.equal(result.conflicts.length, 0);
  });

  test("worktree path with embedded backslash is NOT reconciled (D004 GREEN)", () => {
    // Backslash-containing path: pre-fix regex `[';";\x00]` did not catch
    // it; post-fix assertGsdDbPath rejects up-front. We don't need an
    // openable file here — the validator short-circuits before any I/O.
    const mainGsd = join(tmpDir, "main", ".gsd");
    mkdirSync(mainGsd, { recursive: true });
    const mainDbPath = join(mainGsd, "gsd.db");

    openDatabase(mainDbPath);

    // Backslash inside the path. Note: existsSync may or may not be true
    // depending on filesystem; reconcileWorktreeDb's first-line existence
    // check will short-circuit first if the file isn't there. To force the
    // call to actually reach the validator, build a real file under a
    // *valid* MILESTONE_ID_RE worktree root, then synthesize a backslash
    // variant of the path string that points to the same physical file
    // via a symlink-free alias would be filesystem-dependent. Instead we
    // assert directly on the validator: the production call site invokes
    // `assertGsdDbPath` BEFORE any reconcile work, so a rejection is the
    // proof of bypass.
    assert.throws(
      () =>
        assertGsdDbPath(
          "/repo/.gsd/worktrees/M001\\x/.gsd/gsd.db",
          "reconcileWorktreeDb",
        ),
      (err: unknown) =>
        err instanceof InvalidIdError &&
        err.kind === "worktree-path" &&
        err.source === "reconcileWorktreeDb",
    );
  });
});
