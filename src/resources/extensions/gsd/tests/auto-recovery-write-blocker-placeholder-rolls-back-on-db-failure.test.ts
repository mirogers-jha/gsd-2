// Project/App: GSD-2
// File Purpose: D004 unit regression for M002/S03/T04 — `writeBlockerPlaceholder`
//   must roll back the FS placeholder file AND the plan-file `[ ]→[x]` rewrite
//   when a DB op throws mid-transaction. Uses the `_setUpdateTaskStatusForTests`
//   D005 seam to deterministically force a mid-txn failure (the second DB op
//   in the execute-task branch is `appendEvent`, but `updateTaskStatus` is the
//   first DB write — making it throw exercises the earliest-throw branch where
//   rollback must cancel the plan-file rewrite that lives later in the txn body
//   AND unlink the placeholder file written before the txn).
//
// Pattern: paired PRE-FIX/POST-FIX subtests per MEM058. The PRE-FIX subtest
// inline-replicates the buggy code shape (write file + per-op try/catch that
// swallows + writes plan rewrite anyway) and asserts that BOTH the orphan
// placeholder file AND the modified plan file persist. The POST-FIX subtest
// exercises the real production `writeBlockerPlaceholder` and asserts FS
// rollback + re-throw.

import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { writeBlockerPlaceholder } from "../auto-recovery.ts";
import {
  openDatabase,
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertTask,
  getTask,
  _setUpdateTaskStatusForTests,
} from "../gsd-db.ts";

function createFixtureBase(): string {
  const base = mkdtempSync(join(tmpdir(), "writeblocker-rollback-"));
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks"), { recursive: true });
  return base;
}

function seedDb(base: string): void {
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Test", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "active" });
  insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "Task", status: "pending" });
}

function writePlan(base: string, body: string): string {
  const planPath = join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-PLAN.md");
  writeFileSync(planPath, body, "utf-8");
  return planPath;
}

const PLAN_BODY = [
  "# S01 Plan",
  "",
  "## Tasks",
  "",
  "- [ ] **T01: do the thing**",
  "",
].join("\n");

describe("M002/S03/T04 — writeBlockerPlaceholder FS rollback on DB failure", () => {
  afterEach(() => {
    _setUpdateTaskStatusForTests(null);
    try { closeDatabase(); } catch { /* */ }
  });

  test("POST-FIX: real writeBlockerPlaceholder rolls back placeholder + plan-file when updateTaskStatus throws", () => {
    const base = createFixtureBase();
    try {
      seedDb(base);
      const planPath = writePlan(base, PLAN_BODY);

      // Force the FIRST DB op inside the transaction body to throw.
      _setUpdateTaskStatusForTests(() => {
        throw new Error("INJECTED: updateTaskStatus failure for D004 rollback test");
      });

      // Pre-call snapshot for plan content + placeholder presence.
      const planBefore = readFileSync(planPath, "utf-8");
      const placeholderPath = join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks", "T01-SUMMARY.md");
      assert.equal(existsSync(placeholderPath), false, "placeholder must not exist pre-call");

      // The transactional fix re-throws after rolling back FS state.
      assert.throws(
        () => writeBlockerPlaceholder("execute-task", "M001/S01/T01", base, "test rollback"),
        /INJECTED: updateTaskStatus failure/,
        "writeBlockerPlaceholder must propagate the DB failure after rollback",
      );

      // (a) placeholder file MUST be unlinked
      assert.equal(
        existsSync(placeholderPath),
        false,
        "POST-FIX: placeholder file must be unlinked on rollback (no orphan FS state)",
      );

      // (b) plan file content MUST match pre-call snapshot (no [ ] -> [x])
      const planAfter = readFileSync(planPath, "utf-8");
      assert.equal(
        planAfter,
        planBefore,
        "POST-FIX: plan file must be restored to pre-call content on rollback",
      );

      // (c) DB row for the task MUST be unchanged (transaction rolled back)
      const taskAfter = getTask("M001", "S01", "T01");
      assert.equal(
        taskAfter?.status,
        "pending",
        "POST-FIX: DB task status must remain 'pending' after rollback",
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("PRE-FIX: inline-replicated buggy shape leaks orphan placeholder + half-applied plan rewrite", () => {
    // This subtest documents the bug as it existed before the fix:
    //   1. writeFileSync(absPath, content)            // FS placeholder
    //   2. clearPathCache(); clearParseCache();       // (cache)
    //   3. try { updateTaskStatus(...); plan-rewrite } catch (e) { logWarning }
    //
    // The per-op try/catch swallowed the throw and the FS placeholder was left
    // in place even though the DB row stayed pending — producing the exact
    // unrecoverable state that the M002/S03/T04 fix eliminates: subsequent
    // recovery attempts cannot re-fire because the file already exists.
    const base = createFixtureBase();
    try {
      seedDb(base);
      const planPath = writePlan(base, PLAN_BODY);
      const placeholderPath = join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks", "T01-SUMMARY.md");

      // Replicate the buggy shape inline. Note: NO transaction(); per-op try/catch.
      writeFileSync(placeholderPath, "BUGGY PRE-FIX placeholder", "utf-8");
      // (cache-clear elided; not relevant to the FS-leak shape)
      let updateThrew = false;
      try {
        // Simulate the swallowed throw on the first DB op.
        throw new Error("INJECTED: updateTaskStatus failure for PRE-FIX subtest");
      } catch (_e) {
        updateThrew = true;
        // Pre-fix code logged a warning and continued — the plan rewrite still ran.
      }
      assert.equal(updateThrew, true, "the PRE-FIX shape swallows the first DB op error");
      // Pre-fix code performed the plan rewrite even though updateTaskStatus had failed.
      const updatedPlan = PLAN_BODY.replace(
        /^(\s*-\s+)\[ \]\s+\*\*T01:/m,
        "$1[x] **T01:",
      );
      writeFileSync(planPath, updatedPlan, "utf-8");

      // After the buggy sequence the orphan placeholder file persists AND the
      // plan file was modified — matching the reported bug shape.
      assert.equal(
        existsSync(placeholderPath),
        true,
        "PRE-FIX: orphan placeholder file persists after swallowed DB failure (the bug)",
      );
      const planContent = readFileSync(planPath, "utf-8");
      assert.notEqual(
        planContent,
        PLAN_BODY,
        "PRE-FIX: plan file shows half-applied [ ]→[x] rewrite (the bug)",
      );

      // Cleanup leaked artifacts so the afterEach doesn't see surprising state.
      try { unlinkSync(placeholderPath); } catch { /* */ }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("POST-FIX: success path leaves placeholder + plan rewrite + DB row consistent (no rollback when no throw)", () => {
    const base = createFixtureBase();
    try {
      seedDb(base);
      const planPath = writePlan(base, PLAN_BODY);
      const placeholderPath = join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks", "T01-SUMMARY.md");

      // No seam injection — happy path through the production txn body.
      const result = writeBlockerPlaceholder("execute-task", "M001/S01/T01", base, "happy path");
      assert.ok(result, "writeBlockerPlaceholder must return diagnostic on success");

      assert.equal(existsSync(placeholderPath), true, "placeholder file present on success");
      const taskAfter = getTask("M001", "S01", "T01");
      assert.equal(taskAfter?.status, "complete", "DB task complete on success");
      const planContent = readFileSync(planPath, "utf-8");
      assert.match(planContent, /\[x\]\s+\*\*T01:/, "plan file checkbox flipped on success");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("POST-FIX: source guard — writeBlockerPlaceholder routes DB ops through transaction()", () => {
    // D004 source-grep guard (per MEM060 hardening pattern + MEM058 paired
    // subtests): regressions that delete the transaction() wrapper or move
    // the FS rollback catch out of the function should fail this subtest
    // even without an integration repro. Mechanically auditable.
    const src = readFileSync(
      new URL("../auto-recovery.ts", import.meta.url),
      "utf-8",
    );
    // Must include the transaction() wrapper for blocker-placeholder DB ops.
    assert.match(
      src,
      /writeBlockerPlaceholder[\s\S]*?transaction\(\(\)\s*=>\s*\{/,
      "source guard: writeBlockerPlaceholder must wrap DB ops in transaction(() => { ... })",
    );
    // Must include the FS rollback catch (re-thrown after unlink + plan restore).
    assert.match(
      src,
      /writeBlockerPlaceholder transaction failed; FS rollback applied/,
      "source guard: rollback catch must log the canonical M002/S03/T04 marker",
    );
    // Cache invalidation must live AFTER the transaction (per inline rationale).
    const txStart = src.indexOf("transaction(() => {");
    const cacheClear = src.indexOf("clearPathCache();", txStart);
    const txEnd = src.indexOf("});", txStart);
    assert.ok(txStart > 0 && txEnd > 0 && cacheClear > 0, "source guard: txn block + cache-clear must both be present");
    assert.ok(cacheClear > txEnd, "source guard: clearPathCache() must run AFTER the transaction returns");
  });
});
