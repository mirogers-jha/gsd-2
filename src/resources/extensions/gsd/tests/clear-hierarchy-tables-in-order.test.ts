// Project/App: GSD-2
// File Purpose: Unit test for the private clearHierarchyTablesInOrder helper
// in gsd-db.ts. Uses a recording-fake DbAdapter to assert the FK-safe DELETE
// order across the full 10-table hierarchy. Guards against silent reordering
// or omission that would re-open the restoreManifest FK-violation bug
// (M001/S03 CRITICAL #1).

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { DbAdapter, DbStatement } from "../db-adapter.ts";
import { _clearHierarchyTablesInOrderForTests as clearHierarchyTablesInOrder } from "../gsd-db.ts";

// ─── Recording fake DbAdapter ────────────────────────────────────────────────

interface RecordingFake {
  adapter: DbAdapter;
  calls: string[];
}

function makeRecordingFake(): RecordingFake {
  const calls: string[] = [];
  const noopStmt: DbStatement = {
    run() {
      return undefined;
    },
    get() {
      return undefined;
    },
    all() {
      return [];
    },
  };
  const adapter: DbAdapter = {
    exec(sql: string): void {
      calls.push(sql);
    },
    prepare(_sql: string): DbStatement {
      return noopStmt;
    },
    close(): void {
      /* noop */
    },
  };
  return { adapter, calls };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("clearHierarchyTablesInOrder", () => {
  it("issues exactly the 10 expected DELETEs in FK-safe order", () => {
    const { adapter, calls } = makeRecordingFake();

    clearHierarchyTablesInOrder(adapter);

    // Exact, ordered contract — assertions guard against reorder, omit, or
    // append. If a future schema adds a hierarchy table, this test must be
    // updated in the same commit as the helper change.
    assert.deepEqual(calls, [
      "DELETE FROM verification_evidence",
      "DELETE FROM quality_gates",
      "DELETE FROM slice_dependencies",
      "DELETE FROM assessments",
      "DELETE FROM replan_history",
      "DELETE FROM milestone_commit_attributions",
      "DELETE FROM tasks",
      "DELETE FROM slices",
      "DELETE FROM milestone_leases",
      "DELETE FROM milestones",
    ]);
  });

  it("issues exactly 10 statements (length guard for accidental additions)", () => {
    const { adapter, calls } = makeRecordingFake();

    clearHierarchyTablesInOrder(adapter);

    assert.equal(calls.length, 10);
  });

  it("does not open its own transaction (no BEGIN/COMMIT/ROLLBACK emitted)", () => {
    const { adapter, calls } = makeRecordingFake();

    clearHierarchyTablesInOrder(adapter);

    for (const sql of calls) {
      assert.ok(
        !/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(sql),
        `helper must not emit transaction control SQL: ${sql}`,
      );
    }
  });

  it("does NOT delete from `decisions` (excluded by design)", () => {
    const { adapter, calls } = makeRecordingFake();

    clearHierarchyTablesInOrder(adapter);

    for (const sql of calls) {
      assert.ok(
        !/decisions/i.test(sql),
        `helper must not touch decisions table: ${sql}`,
      );
    }
  });
});
