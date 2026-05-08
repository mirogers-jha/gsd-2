/**
 * D004 reproduce-and-prevent regression test for M001/S05/T02:
 * `vacuumDatabase` and `checkpointDatabase` HIGH-severity bug — both
 * functions previously called `currentDb.exec("VACUUM")` /
 * `currentDb.exec("PRAGMA wal_checkpoint(TRUNCATE)")` directly, with no
 * gate on `isInTransaction()`. SQLite refuses VACUUM inside a transaction,
 * and `wal_checkpoint(TRUNCATE)` cannot truncate the WAL while a writer
 * holds an open transaction. The pre-fix code masks both with the
 * try/catch + `logWarning` shape, losing the original error context and
 * silently failing to do work the caller expected to be done.
 *
 * The fix adds an early-return guard:
 *   if (isInTransaction()) {
 *     logWarning("db", "<op> skipped: inside transaction");
 *     return;
 *   }
 * keeping the non-throw contract for both functions while making the skip
 * observable through the `peekLogs()` test seam (and `rg` of activity logs
 * in production).
 *
 * Approach for log capture: this test uses `peekLogs()` + `_resetLogs()`
 * from `workflow-logger.ts` (the same in-process buffer the production
 * auto-loop drains). No stderr monkey-patching needed — `logWarning` is
 * intentionally NOT written to stderr (see workflow-logger.ts lines 9-12).
 *
 * Direct-import only (MEM009): pulled from `gsd-db.ts`, never via a barrel.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  openDatabase,
  closeDatabase,
  insertMilestone,
  vacuumDatabase,
  checkpointDatabase,
  transaction,
  isInTransaction,
} from "../gsd-db.ts";
import {
  peekLogs,
  _resetLogs,
  setStderrLoggingEnabled,
} from "../workflow-logger.ts";

test("vacuumDatabase + checkpointDatabase gate on isInTransaction() — skip + warn instead of throwing", () => {
  const opened = openDatabase(":memory:");
  assert.equal(opened, true, "in-memory DB must open");

  // Silence stderr noise from any incidental error logs the harness emits
  // and start with a clean log buffer so peekLogs() reflects only what
  // this test produced.
  const previousStderr = setStderrLoggingEnabled(false);
  _resetLogs();

  try {
    // Seed at least one writable row so VACUUM has work to compact.
    insertMilestone({ id: "M001", title: "Alpha", status: "active" });

    // Sanity: not inside a transaction yet.
    assert.equal(isInTransaction(), false, "must start outside a transaction");

    // (a) Wrap both calls in an outer transaction. Pre-fix this throws
    //     SQLite "cannot VACUUM from within a transaction" out of
    //     `vacuumDatabase` (caught by its try/catch and downgraded to a
    //     non-skip `logWarning("db", "VACUUM failed: ...")`). Post-fix,
    //     both functions return early without touching the DB.
    assert.doesNotThrow(() => {
      transaction(() => {
        vacuumDatabase();
        checkpointDatabase();
      });
    }, "vacuum/checkpoint inside transaction must not throw");

    // (b) At least one captured warning includes the substring
    //     "inside transaction". Post-fix we expect TWO — one per gate.
    //     Pre-fix the only captured warning is "VACUUM failed: ..."
    //     (no "inside transaction" substring) and the checkpoint silently
    //     no-ops on the truncate side.
    const insideTxnWarnings = peekLogs().filter(
      (e) =>
        e.severity === "warn" &&
        e.component === "db" &&
        e.message.includes("inside transaction"),
    );
    assert.ok(
      insideTxnWarnings.length >= 1,
      `expected ≥1 'inside transaction' warning, got ${insideTxnWarnings.length}: ` +
        JSON.stringify(peekLogs().map((e) => `${e.severity}/${e.component}: ${e.message}`)),
    );

    // (c) Outer transaction committed cleanly — runner depth is back to 0.
    assert.equal(
      isInTransaction(),
      false,
      "isInTransaction() must return false after the outer transaction commits",
    );
  } finally {
    setStderrLoggingEnabled(previousStderr);
    closeDatabase();
  }
});
