/**
 * Behavioural test for CRITICAL #3 (S01-PLAN, D004): a malicious worktree
 * directory name like `M001'; DROP TABLE--` must be rejected at the sqlite3
 * boundary BEFORE the runner is invoked, while a sibling valid `M001`
 * worktree is still discovered.
 *
 * Strategy:
 *   - Build a real tmp tree containing both a valid `M001` worktree and a
 *     malicious-named worktree. macOS APFS / ext4 both allow the malicious
 *     name; if mkdirSync fails the test falls back to a stub readdirSync via
 *     a wrapper around `_discoverDbCompletedMilestonesForTests`.
 *   - Inject a counting fake runner via `_setSqliteRunnerForTests` so we
 *     never spawn `sqlite3` and can assert the runner is called exactly once
 *     for the valid entry.
 *   - Both worktrees get an empty placeholder `gsd.db` at the path
 *     `resolveGsdPathContract` resolves to so `existsSync` passes.
 *   - Optionally assert `logError("parallel", "rejected ID at sqlite3 boundary", ...)`
 *     was buffered for the malicious entry via `peekLogs` from
 *     `workflow-logger`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  _setSqliteRunnerForTests,
  type SqliteCliResult,
} from "../parallel-sqlite-cli.ts";
import { _discoverDbCompletedMilestonesForTests } from "../parallel-merge.ts";
import { _resetLogs, peekLogs } from "../workflow-logger.ts";

const VALID_ID = "M001";
const MALICIOUS_ID = "M001'; DROP TABLE--";

interface Fixture {
  tmpBase: string;
  cleanup: () => void;
  /** True when both worktree directories were created on disk. */
  bothCreated: boolean;
}

function tryBuildFixture(): Fixture {
  const tmpBase = mkdtempSync(join(tmpdir(), "gsd-malicious-worktree-"));
  const worktreeRoot = join(tmpBase, ".gsd", "worktrees");
  mkdirSync(worktreeRoot, { recursive: true });

  // Valid worktree
  mkdirSync(join(worktreeRoot, VALID_ID, ".gsd"), { recursive: true });

  // Project DB lives at <tmpBase>/.gsd/gsd.db per resolveGsdPathContract
  // when originalProjectRoot=tmpBase. Create empty placeholder so existsSync passes.
  writeFileSync(join(tmpBase, ".gsd", "gsd.db"), "");

  let bothCreated = false;
  try {
    mkdirSync(join(worktreeRoot, MALICIOUS_ID, ".gsd"), { recursive: true });
    bothCreated = true;
  } catch {
    // Some filesystems / sandboxes refuse the malicious name. We will fall
    // back to a stub readdirSync override below.
    bothCreated = false;
  }

  return {
    tmpBase,
    bothCreated,
    cleanup: () => {
      try { rmSync(tmpBase, { recursive: true, force: true }); } catch { /* best effort */ }
    },
  };
}

test("discoverDbCompletedMilestones rejects malicious worktree name and continues with valid sibling", (t) => {
  _resetLogs();
  const fx = tryBuildFixture();
  t.after(() => {
    _setSqliteRunnerForTests(null);
    _resetLogs();
    fx.cleanup();
  });

  if (!fx.bothCreated) {
    // Filesystem refused to create the malicious-name directory. Skip rather
    // than weaken the assertion — the parallel-sqlite-cli unit test already
    // covers the validator-throws-then-runner-not-called path; this
    // behavioural test exists to prove the loop continues over BOTH entries.
    t.skip("fs refused malicious worktree directory name; relying on parallel-sqlite-cli unit test");
    return;
  }

  // Counting fake runner — proves the wrapper never spawns sqlite3.
  const calls: string[] = [];
  _setSqliteRunnerForTests((args): SqliteCliResult => {
    // The wrapper re-derives sql; we only care that we received a call. We
    // record dbPath because the mid is not threaded into the runner args
    // (validator already ran with mid). The valid worktree is the only
    // entry whose dbPath should reach the runner.
    calls.push(args.dbPath);
    return { stdout: "complete", status: 0 };
  });

  const completed = _discoverDbCompletedMilestonesForTests(fx.tmpBase);

  // Runner was reached exactly once — only for the valid entry.
  assert.equal(calls.length, 1, "runner must be invoked once (only the valid entry)");

  // The valid entry was discovered as complete.
  assert.ok(completed.has(VALID_ID), "valid M001 must be discovered as complete");
  assert.ok(!completed.has(MALICIOUS_ID), "malicious entry must not appear in completed set");

  // logError fired for the malicious entry.
  const errs = peekLogs().filter(
    (e) => e.severity === "error" && (e.message || "").includes("rejected ID at sqlite3 boundary"),
  );
  assert.ok(errs.length >= 1, "at least one logError must have fired for the malicious entry");
  const malErr = errs.find((e) => e.context?.attemptedId === MALICIOUS_ID);
  assert.ok(malErr, "logError must include attemptedId of the malicious worktree");
  assert.equal(malErr?.context?.source, "discoverDbCompletedMilestones");
  assert.equal(malErr?.context?.kind, "milestone");
});
