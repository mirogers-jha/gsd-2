// Project/App: GSD-2
// File Purpose: D004 reproduce-and-prevent regression test for CRITICAL #2 —
// `applyMigrationV22QualityGateRepair` must be idempotent across a
// partial-failure-then-retry interleaving. Pre-fix this test FAILS on Run 2
// with `table quality_gates_new already exists`; post-fix it PASSES.
//
// Background:
//   `db-migration-steps.ts:applyMigrationV22QualityGateRepair` runs a
//   table-rebuild ritual (`CREATE TABLE quality_gates_new` → row-copy hook →
//   DROP quality_gates → RENAME quality_gates_new). The CREATE TABLE is
//   executed without an `IF NOT EXISTS` guard. In the happy path, the outer
//   BEGIN/COMMIT/ROLLBACK in `gsd-db.ts:migrateSchema` undoes a thrown CREATE.
//   But hostile interleavings — process SIGKILL between CREATE and ROLLBACK,
//   or a ROLLBACK that itself fails — can leave `quality_gates_new` persisted.
//   The next startup retries the migration (schema_version is still 21), hits
//   the bare CREATE TABLE, and dies with `table quality_gates_new already
//   exists`. The DB is then permanently stuck at v21.
//
// Reproduction strategy:
//   The `MigrationV22Hooks.copyQualityGateRowsToRepairedTable` injection seam
//   (D005 deterministic-seam pattern) lets us deterministically simulate the
//   partial-failure-then-retry: Run 1 throws AFTER `CREATE TABLE
//   quality_gates_new` succeeds but BEFORE row-copy completes; Run 2 calls
//   again with a normal hook. We MUST call `applyMigrationV22QualityGateRepair`
//   directly on the adapter — NOT via `migrateSchema` — because the outer
//   BEGIN/ROLLBACK would otherwise undo the CREATE on the throw and mask the
//   bug (per CONTEXT 'Common Pitfalls').
//
// Belt-and-braces subtest:
//   Seed an orphan row into the leftover `quality_gates_new` between Run 1 and
//   Run 2 to prove that `DROP IF EXISTS` (Run 2 post-fix) discards stale state
//   rather than silently leaking it via `CREATE IF NOT EXISTS` + `INSERT OR
//   IGNORE` (the rejected alternative in S04-CONTEXT).

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

import { createDbAdapter, type DbAdapter } from "../db-adapter.ts";
import {
  applyMigrationV2Artifacts,
  applyMigrationV3Memories,
  applyMigrationV4DecisionMadeBy,
  applyMigrationV5HierarchyTables,
  applyMigrationV6SliceSummaries,
  applyMigrationV7Dependencies,
  applyMigrationV8PlanningFields,
  applyMigrationV9Ordering,
  applyMigrationV10ReplanTrigger,
  applyMigrationV11TaskPlanning,
  applyMigrationV12QualityGates,
  applyMigrationV13HotPathIndexes,
  applyMigrationV22QualityGateRepair,
} from "../db-migration-steps.ts";

const _require = createRequire(import.meta.url);

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: unknown;
  pk: number;
}

function openMemoryAdapter(): { adapter: DbAdapter; close: () => void } {
  const sqlite = _require("node:sqlite") as { DatabaseSync: new (path: string) => unknown };
  const raw = new sqlite.DatabaseSync(":memory:");
  const adapter = createDbAdapter(raw);
  return {
    adapter,
    close: () => adapter.close(),
  };
}

function tableInfo(db: DbAdapter, table: string): ColumnInfo[] {
  return db.prepare(`PRAGMA table_info(${table})`).all() as unknown as ColumnInfo[];
}

function tableExists(db: DbAdapter, table: string): boolean {
  return !!db
    .prepare("SELECT 1 as present FROM sqlite_master WHERE type='table' AND name=?")
    .get(table);
}

// Mirror of `runUpToV13` in db-migration-steps.integration.test.ts. Brings a
// fresh in-memory DB up to the v13 baseline (which is far enough — V22 only
// touches quality_gates / assessments).
function runUpToV13(adapter: DbAdapter): void {
  adapter.exec(`
    CREATE TABLE schema_version (
      version INTEGER NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);
  adapter.exec(`
    CREATE TABLE decisions (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      when_context TEXT NOT NULL DEFAULT '',
      scope TEXT NOT NULL DEFAULT '',
      decision TEXT NOT NULL DEFAULT '',
      choice TEXT NOT NULL DEFAULT '',
      rationale TEXT NOT NULL DEFAULT '',
      revisable TEXT NOT NULL DEFAULT '',
      superseded_by TEXT DEFAULT NULL
    )
  `);
  adapter.exec(`
    CREATE TABLE requirements (
      id TEXT PRIMARY KEY,
      class TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      why TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT '',
      primary_owner TEXT NOT NULL DEFAULT '',
      supporting_slices TEXT NOT NULL DEFAULT '',
      validation TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      full_content TEXT NOT NULL DEFAULT '',
      superseded_by TEXT DEFAULT NULL
    )
  `);
  adapter.exec(
    "CREATE VIEW active_decisions AS SELECT * FROM decisions WHERE superseded_by IS NULL",
  );
  adapter.exec(
    "CREATE VIEW active_requirements AS SELECT * FROM requirements WHERE superseded_by IS NULL",
  );

  applyMigrationV2Artifacts(adapter);
  applyMigrationV3Memories(adapter);
  applyMigrationV4DecisionMadeBy(adapter);
  applyMigrationV5HierarchyTables(adapter);
  applyMigrationV6SliceSummaries(adapter);
  applyMigrationV7Dependencies(adapter);
  applyMigrationV8PlanningFields(adapter);
  applyMigrationV9Ordering(adapter);
  applyMigrationV10ReplanTrigger(adapter);
  applyMigrationV11TaskPlanning(adapter);
  applyMigrationV12QualityGates(adapter);
  applyMigrationV13HotPathIndexes(adapter, () => {});
}

// Drops the v13-shaped quality_gates and replaces it with the pre-v22
// shape (nullable task_id) — same fixture pattern used by the canonical V22
// integration test at db-migration-steps.integration.test.ts:318-340.
function seedNullableTaskIdQualityGates(adapter: DbAdapter): void {
  adapter.exec("DROP INDEX IF EXISTS idx_quality_gates_pending");
  adapter.exec("DROP TABLE quality_gates");
  adapter.exec(`
    CREATE TABLE quality_gates (
      milestone_id TEXT NOT NULL,
      slice_id TEXT NOT NULL,
      gate_id TEXT NOT NULL,
      task_id TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      verdict TEXT NOT NULL DEFAULT '',
      rationale TEXT NOT NULL DEFAULT '',
      findings TEXT NOT NULL DEFAULT '',
      evaluated_at TEXT DEFAULT NULL,
      PRIMARY KEY (milestone_id, slice_id, gate_id, task_id),
      FOREIGN KEY (milestone_id, slice_id) REFERENCES slices(milestone_id, id)
    )
  `);
}

describe("V22 QualityGateRepair partial-failure-then-retry idempotency (D004)", () => {
  test("Run 1 leaves orphan quality_gates_new; Run 2 must complete cleanly (idempotent retry)", () => {
    const { adapter, close } = openMemoryAdapter();
    try {
      runUpToV13(adapter);
      seedNullableTaskIdQualityGates(adapter);

      // Pre-condition sanity: nullable task_id, no orphan table yet.
      const before = tableInfo(adapter, "quality_gates").find((c) => c.name === "task_id");
      assert.ok(before);
      assert.equal(before!.notnull, 0, "pre-repair fixture should have nullable task_id");
      assert.equal(
        tableExists(adapter, "quality_gates_new"),
        false,
        "fixture should not yet contain quality_gates_new",
      );

      // ── Run 1: simulate partial failure ──
      // Throw AFTER CREATE TABLE quality_gates_new succeeds but BEFORE row-copy
      // completes. This deterministically reproduces the persisted-orphan
      // interleaving (SIGKILL between CREATE and ROLLBACK, or failed ROLLBACK).
      assert.throws(
        () => {
          applyMigrationV22QualityGateRepair(adapter, {
            copyQualityGateRowsToRepairedTable: () => {
              throw new Error("simulated copy failure (partial v22 run)");
            },
          });
        },
        /simulated copy failure/,
        "Run 1 hook must throw and surface the simulated copy failure",
      );

      // The orphan must persist — proving the bug-prone state is reachable.
      // We are calling `applyMigrationV22QualityGateRepair` directly (NOT via
      // `migrateSchema`), so there is no outer ROLLBACK to undo the CREATE.
      assert.equal(
        tableExists(adapter, "quality_gates_new"),
        true,
        "Run 1 must leave quality_gates_new behind to reproduce the partial-failure state",
      );

      // ── Run 2: retry with a normal (no-op) hook ──
      // PRE-FIX EXPECTATION: this throws `table quality_gates_new already
      //   exists` because the bare CREATE TABLE has no IF NOT EXISTS guard.
      // POST-FIX EXPECTATION: this succeeds because the DROP TABLE IF EXISTS
      //   guard wipes the orphan before recreating cleanly.
      let copyCalled = 0;
      applyMigrationV22QualityGateRepair(adapter, {
        copyQualityGateRowsToRepairedTable: () => {
          copyCalled += 1;
        },
      });

      assert.equal(copyCalled, 1, "Run 2 row-copy hook must fire exactly once on retry");

      // Post-condition: the rebuild completed — task_id is NOT NULL and the
      // staging table was renamed away.
      const after = tableInfo(adapter, "quality_gates").find((c) => c.name === "task_id");
      assert.ok(after);
      assert.equal(after!.notnull, 1, "Run 2 must finish the rebuild with task_id NOT NULL");
      assert.equal(
        tableExists(adapter, "quality_gates_new"),
        false,
        "Run 2 must clean up quality_gates_new after RENAME",
      );
    } finally {
      close();
    }
  });

  test("orphan rows in leftover quality_gates_new are discarded by retry (DROP IF EXISTS, not CREATE IF NOT EXISTS leak)", () => {
    const { adapter, close } = openMemoryAdapter();
    try {
      runUpToV13(adapter);
      seedNullableTaskIdQualityGates(adapter);

      // Run 1: same partial failure pattern.
      assert.throws(
        () => {
          applyMigrationV22QualityGateRepair(adapter, {
            copyQualityGateRowsToRepairedTable: () => {
              throw new Error("simulated copy failure (partial v22 run)");
            },
          });
        },
        /simulated copy failure/,
      );

      // Seed a deliberately-stale "ghost" row into the orphan staging table.
      // If the post-fix Run 2 used `CREATE TABLE IF NOT EXISTS quality_gates_new`
      // + `INSERT OR IGNORE`, this ghost row would silently survive the
      // rename. The chosen `DROP TABLE IF EXISTS` semantics must wipe it.
      //
      // The staging table has FOREIGN KEY (milestone_id, slice_id) REFERENCES
      // slices(milestone_id, id). We turn FK enforcement off for the synthetic
      // seed because it does NOT model a real-world reachable state — the
      // bug shape we care about is "the table physically exists from a prior
      // partial run", not "the rows referentially validate". Restored
      // immediately so Run 2 sees the same FK posture as production.
      adapter.exec("PRAGMA foreign_keys = OFF");
      adapter.exec(
        "INSERT INTO quality_gates_new (milestone_id, slice_id, gate_id, task_id, status) " +
          "VALUES ('M999', 'S99', 'GHOST', '', 'pending')",
      );
      adapter.exec("PRAGMA foreign_keys = ON");
      const orphanRowsBefore = adapter
        .prepare("SELECT count(*) AS n FROM quality_gates_new")
        .get() as { n: number };
      assert.equal(orphanRowsBefore.n, 1, "subtest setup should have planted one orphan row");

      // Run 2: retry with a normal (no-op) hook. Pre-fix this throws; post-fix
      // the rebuild succeeds AND the ghost row must be gone after RENAME.
      applyMigrationV22QualityGateRepair(adapter, {
        copyQualityGateRowsToRepairedTable: () => {},
      });

      // After RENAME quality_gates_new → quality_gates, the ghost row must NOT
      // appear in the live table. (The repair hook copies from the original
      // quality_gates, which had no ghost row.)
      const ghostInLiveTable = adapter
        .prepare("SELECT count(*) AS n FROM quality_gates WHERE gate_id = 'GHOST'")
        .get() as { n: number };
      assert.equal(
        ghostInLiveTable.n,
        0,
        "ghost row from the orphan staging table must NOT survive the retry rebuild",
      );
    } finally {
      close();
    }
  });
});
