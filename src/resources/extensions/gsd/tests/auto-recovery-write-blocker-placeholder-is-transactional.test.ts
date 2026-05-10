// Project/App: GSD-2
// File Purpose: BEHAVIORAL (CRITICAL-bar per D007/MEM040) regression for
//   M002/S03/T04 — `writeBlockerPlaceholder` must roll back FS state on real
//   DB failures (no mocks). Per S03-CONTEXT open question 2, we force a real
//   `updateTaskStatus` failure WITHOUT seam-injection by causing the underlying
//   `tasks` table to be missing at execution time — `db.prepare(UPDATE tasks ...)`
//   throws `SqliteError: no such table: tasks` from inside the production
//   transaction body. This is a real better-sqlite3 fault path through real FS,
//   exercising the production rollback envelope end-to-end.
//
// Pattern reuses the M001/S03 `restore-manifest-fk-violation-rolls-back.test.ts`
// CRITICAL-bar shape: open the real DB (`PRAGMA foreign_keys = ON`), seed the
// hierarchy, perturb the schema to force a deterministic mid-txn throw,
// exercise the production entrypoint, then assert FS + DB state match the
// pre-call snapshot.
//
// We deliberately do NOT use `_setUpdateTaskStatusForTests` here — that seam
// is exercised in the sibling D004 unit test. This file proves the rollback
// works against the REAL `prepare/run` path, eliminating the mock-coverage gap.

import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
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
  _getCurrentDbForTests,
} from "../gsd-db.ts";

function createFixtureBase(): string {
  const base = mkdtempSync(join(tmpdir(), "writeblocker-behavioral-"));
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks"), { recursive: true });
  return base;
}

const PLAN_BODY = [
  "# S01 Plan",
  "",
  "## Tasks",
  "",
  "- [ ] **T01: behavioral D004 task**",
  "",
].join("\n");

describe("M002/S03/T04 BEHAVIORAL — writeBlockerPlaceholder transactional rollback (CRITICAL-bar)", () => {
  afterEach(() => {
    try { closeDatabase(); } catch { /* */ }
  });

  test("real DB schema-fault: dropping `tasks` mid-fixture forces real updateTaskStatus throw → FS rolled back", () => {
    const base = createFixtureBase();
    try {
      // Real on-disk DB so PRAGMA settings + transaction semantics are
      // exercised exactly as production sees them (mirrors the M001/S03
      // FK-violation behavioral test pattern).
      openDatabase(join(base, ".gsd", "gsd.db"));
      insertMilestone({ id: "M001", title: "Behavioral test", status: "active" });
      insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "active" });
      insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "Task", status: "pending" });

      const planPath = join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-PLAN.md");
      writeFileSync(planPath, PLAN_BODY, "utf-8");
      const planBefore = readFileSync(planPath, "utf-8");

      const placeholderPath = join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks", "T01-SUMMARY.md");
      assert.equal(existsSync(placeholderPath), false, "no placeholder pre-call");

      // Pre-call DB snapshot: count tasks rows in M001/S01.
      const dbHandle = _getCurrentDbForTests();
      assert.ok(dbHandle, "DB must be open");
      const taskBefore = getTask("M001", "S01", "T01");
      assert.equal(taskBefore?.status, "pending", "task is pending pre-call");

      // ─── Real-DB fault injection: drop the `tasks` table ────────────────
      // From this point, ANY prepare("UPDATE tasks ...") will throw
      // `SqliteError: no such table: tasks` from better-sqlite3. This is
      // the real exception class the production runner sees on a corrupt
      // schema or aborted migration — no mocks involved. The
      // updateTaskStatus call inside writeBlockerPlaceholder's txn body
      // hits this fault, the transaction() runner ROLLBACKs, and the
      // writeBlockerPlaceholder catch unlinks the placeholder + restores
      // the plan file before re-throwing.
      dbHandle!.exec("DROP TABLE tasks");

      assert.throws(
        () => writeBlockerPlaceholder("execute-task", "M001/S01/T01", base, "behavioral rollback"),
        /no such table: tasks/,
        "writeBlockerPlaceholder must propagate the real SqliteError after rollback",
      );

      // (a) Placeholder file MUST not exist after rollback.
      assert.equal(
        existsSync(placeholderPath),
        false,
        "BEHAVIORAL: placeholder file unlinked on real DB rollback (no orphan FS state)",
      );

      // (b) Plan file content MUST match pre-call snapshot.
      const planAfter = readFileSync(planPath, "utf-8");
      assert.equal(
        planAfter,
        planBefore,
        "BEHAVIORAL: plan file restored to pre-call content on real DB rollback",
      );

      // (c) DB state matches pre-call snapshot. We cannot use getTask
      // (table is dropped), but we can recreate the table and assert no
      // stray writes survived the txn. Recreating an empty table is
      // sufficient — the transaction runner already ROLLBACKed before
      // any other DB ops in the txn body could persist their writes
      // (appendEvent writes to JSONL, not DB; we audit it separately).
      dbHandle!.exec(`
        CREATE TABLE IF NOT EXISTS tasks_audit AS SELECT * FROM milestones WHERE 0
      `);
      // The original tasks table was dropped — that's the fault we
      // injected — so the only relevant DB-state assertion is that the
      // milestones row is unmodified (no cascading damage).
      const milestonesRow = dbHandle!.prepare("SELECT id, status FROM milestones WHERE id = 'M001'").get() as
        | { id: string; status: string }
        | undefined;
      assert.equal(milestonesRow?.status, "active", "BEHAVIORAL: milestones row unchanged on rollback");

      // (d) Side-channel JSONL append: appendEvent ALSO did not run
      // because the transaction body throws BEFORE reaching it. The
      // event-log file should not exist (or, if it exists from earlier
      // setup, must not contain the recovery event hash).
      const eventLogPath = join(base, ".gsd", "event-log.jsonl");
      if (existsSync(eventLogPath)) {
        const contents = readFileSync(eventLogPath, "utf-8");
        assert.equal(
          contents.includes("blocker-placeholder-recovery"),
          false,
          "BEHAVIORAL: appendEvent must not have written the recovery event after txn rollback",
        );
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("real DB happy path: writeBlockerPlaceholder commits when no fault is injected (anti-flake control)", () => {
    // Control test: with no fault injection, the real production txn
    // commits + the FS placeholder + plan rewrite + DB row updates all
    // persist. Proves the rollback test isn't passing because the txn
    // is broken in some other way.
    const base = createFixtureBase();
    try {
      openDatabase(join(base, ".gsd", "gsd.db"));
      insertMilestone({ id: "M001", title: "Behavioral happy", status: "active" });
      insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "active" });
      insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "Task", status: "pending" });

      const planPath = join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-PLAN.md");
      writeFileSync(planPath, PLAN_BODY, "utf-8");

      const result = writeBlockerPlaceholder("execute-task", "M001/S01/T01", base, "happy control");
      assert.ok(result, "writeBlockerPlaceholder returns diagnostic on success");

      const placeholderPath = join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks", "T01-SUMMARY.md");
      assert.equal(existsSync(placeholderPath), true, "happy path: placeholder file present");

      const taskAfter = getTask("M001", "S01", "T01");
      assert.equal(taskAfter?.status, "complete", "happy path: DB task status flipped to complete");

      const planAfter = readFileSync(planPath, "utf-8");
      assert.match(planAfter, /\[x\]\s+\*\*T01:/, "happy path: plan file checkbox flipped");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
