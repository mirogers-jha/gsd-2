/**
 * D004 reproduce-and-prevent regression test for M001/S05/T01:
 * `setMilestoneQueueOrder` HIGH-severity bug — the function previously
 * issued raw `BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK` calls instead of routing
 * through the depth-tracked `_transactionRunner`. Calling it from inside an
 * outer `transaction(() => ...)` therefore corrupted runner state and
 * caused SQLite to throw `cannot start a transaction within a transaction`.
 *
 * The fix replaces the raw block with `transaction(() => { ... })` so the
 * call participates in the runner's depth tracking.
 *
 * Direct-import only (MEM009): pulled from `gsd-db.ts`, never via a barrel.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  openDatabase,
  closeDatabase,
  insertMilestone,
  getAllMilestones,
  setMilestoneQueueOrder,
  transaction,
  isInTransaction,
} from "../gsd-db.ts";

test("setMilestoneQueueOrder routes through transaction() — nested call does not corrupt runner state", () => {
  const opened = openDatabase(":memory:");
  assert.equal(opened, true, "in-memory DB must open");

  try {
    insertMilestone({ id: "M001", title: "Alpha", status: "active" });
    insertMilestone({ id: "M002", title: "Beta", status: "queued" });

    // (a) No SQLite throw when the inner setMilestoneQueueOrder runs inside
    //     an outer transaction. Pre-fix this throws because raw
    //     `BEGIN IMMEDIATE` inside an active transaction is illegal in SQLite.
    assert.doesNotThrow(() => {
      transaction(() => {
        setMilestoneQueueOrder(["M001", "M002"]);
      });
    }, "nested setMilestoneQueueOrder must not throw — must route through depth-tracked transaction()");

    // (b) Sequence values updated correctly inside the outer transaction.
    const rows = getAllMilestones();
    const byId = new Map(rows.map((r) => [r.id, r]));
    assert.equal(
      byId.get("M001")?.sequence,
      1,
      `M001 sequence must be 1 (got ${byId.get("M001")?.sequence})`,
    );
    assert.equal(
      byId.get("M002")?.sequence,
      2,
      `M002 sequence must be 2 (got ${byId.get("M002")?.sequence})`,
    );

    // (c) After the outer transaction commits, the runner is no longer
    //     inside a transaction. If the inner raw COMMIT had executed and
    //     decremented depth, this would also be false in the buggy code —
    //     but with the fix this MUST remain a clean post-commit state.
    assert.equal(
      isInTransaction(),
      false,
      "isInTransaction() must return false after the outer transaction commits",
    );
  } finally {
    closeDatabase();
  }
});
