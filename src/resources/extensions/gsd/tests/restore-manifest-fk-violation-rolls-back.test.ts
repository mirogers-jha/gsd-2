// Project/App: GSD-2
// File Purpose: Behavioral regression test for M001/S03 CRITICAL #1 — restoreManifest
//   must DELETE all 10 hierarchy tables in FK-safe order before re-inserting from
//   manifest, otherwise SQLITE_CONSTRAINT fires when any of the previously-missed
//   tables (quality_gates, slice_dependencies, assessments, replan_history,
//   milestone_commit_attributions) holds rows for the milestones being replaced.
//
//   This test goes through the public `bootstrapFromManifest` entrypoint and uses
//   the real `openDatabase(":memory:")` connection (which sets `PRAGMA foreign_keys = ON`
//   per gsd-db.ts:122) so PRAGMA semantics are exercised end-to-end. It is the
//   D004 reproduce-and-prevent regression alarm: if anyone reverts the helper call
//   inside `restoreManifest`, this test fails with `SQLITE_CONSTRAINT`.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  openDatabase,
  closeDatabase,
  _getCurrentDbForTests,
} from "../gsd-db.ts";
import { bootstrapFromManifest } from "../workflow-manifest.ts";
import type { StateManifest } from "../workflow-manifest.ts";

describe("restoreManifest FK-violation rolls back (CRITICAL #1, M001/S03)", () => {
  test(
    "bootstrapFromManifest cleanly replaces a fully-seeded hierarchy without SQLITE_CONSTRAINT",
    () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "restore-manifest-fk-"));
      try {
        // Real :memory: open => PRAGMA foreign_keys = ON per gsd-db.ts:122.
        const opened = openDatabase(":memory:");
        assert.equal(opened, true, "openDatabase(:memory:) must succeed");

        const db = _getCurrentDbForTests();
        assert.ok(db, "live currentDb adapter must be available after open");

        // Sanity: prove FK enforcement is on for this connection.
        const fkRow = db!
          .prepare("PRAGMA foreign_keys")
          .get() as { foreign_keys: number } | undefined;
        assert.equal(
          fkRow?.foreign_keys,
          1,
          "PRAGMA foreign_keys must be ON for this connection (regression: gsd-db.ts:122)",
        );

        // ─── Seed all 10 hierarchy tables on M999 ───────────────────────────
        // Order: parents first so child FKs resolve.
        //
        // workers + milestone_leases (milestone_leases FKs to both milestones and workers)
        db!.exec(`
          INSERT INTO workers (worker_id, host, pid, started_at, version, last_heartbeat_at, status, project_root_realpath)
          VALUES ('w-m999', 'localhost', 1, '2026-05-08T00:00:00.000Z', 'test', '2026-05-08T00:00:00.000Z', 'idle', '/tmp/test-root')
        `);

        // milestone (parent of everything else)
        db!.exec(`
          INSERT INTO milestones (id, title, status, depends_on, created_at, completed_at,
            vision, success_criteria, key_risks, proof_strategy,
            verification_contract, verification_integration, verification_operational, verification_uat,
            definition_of_done, requirement_coverage, boundary_map_markdown, sequence)
          VALUES ('M999', 'Pre-restore milestone', 'active', '[]', '2026-05-08T00:00:00.000Z', NULL,
            '', '[]', '[]', '[]', '', '', '', '', '[]', '', '', 0)
        `);

        // slice (FK -> milestones)
        db!.exec(`
          INSERT INTO slices (milestone_id, id, title, status, risk, depends, demo,
            created_at, completed_at, full_summary_md, full_uat_md,
            goal, success_criteria, proof_level, integration_closure, observability_impact,
            sequence, replan_triggered_at, is_sketch, sketch_scope)
          VALUES ('M999', 'S99', 'Pre-restore slice', 'pending', 'low', '[]', '',
            '2026-05-08T00:00:00.000Z', NULL, '', '',
            '', '', '', '', '',
            0, NULL, 0, '')
        `);

        // task (FK -> slices)
        db!.exec(`
          INSERT INTO tasks (milestone_id, slice_id, id, title, status,
            one_liner, narrative, verification_result, duration, completed_at,
            blocker_discovered, blocker_source, escalation_pending, escalation_awaiting_review,
            escalation_artifact_path, escalation_override_applied_at,
            deviations, known_issues, key_files, key_decisions,
            full_summary_md, description, estimate, files, verify, inputs, expected_output,
            observability_impact, full_plan_md, sequence)
          VALUES ('M999', 'S99', 'T99', 'Pre-restore task', 'pending',
            '', '', '', '', NULL,
            0, '', 0, 0, NULL, NULL,
            '', '', '[]', '[]',
            '', '', '', '[]', '', '[]', '[]',
            '', '', 0)
        `);

        // verification_evidence (FK -> tasks)
        db!.exec(`
          INSERT INTO verification_evidence (task_id, slice_id, milestone_id, command, exit_code, verdict, duration_ms, created_at)
          VALUES ('T99', 'S99', 'M999', 'echo seed', 0, '✅ pass', 1, '2026-05-08T00:00:00.000Z')
        `);

        // quality_gates (FK -> slices)
        db!.exec(`
          INSERT INTO quality_gates (milestone_id, slice_id, gate_id, scope, task_id, status, verdict, rationale, findings, evaluated_at)
          VALUES ('M999', 'S99', 'Q5', 'task', 'T99', 'evaluated', 'pass', 'seed', '', '2026-05-08T00:00:00.000Z')
        `);

        // slice_dependencies (FK -> slices x2 — depend on self for simplicity)
        db!.exec(`
          INSERT INTO slice_dependencies (milestone_id, slice_id, depends_on_slice_id)
          VALUES ('M999', 'S99', 'S99')
        `);

        // assessments (FK -> milestones)
        db!.exec(`
          INSERT INTO assessments (path, milestone_id, slice_id, task_id, status, scope, full_content, created_at)
          VALUES ('milestones/M999/ASSESSMENT.md', 'M999', NULL, NULL, 'open', 'milestone', '', '2026-05-08T00:00:00.000Z')
        `);

        // replan_history (FK -> milestones)
        db!.exec(`
          INSERT INTO replan_history (milestone_id, slice_id, task_id, summary, previous_artifact_path, replacement_artifact_path, created_at)
          VALUES ('M999', 'S99', 'T99', 'seed replan', NULL, NULL, '2026-05-08T00:00:00.000Z')
        `);

        // milestone_commit_attributions (no FK but is a hierarchy table cleared by the helper)
        db!.exec(`
          INSERT INTO milestone_commit_attributions (commit_sha, milestone_id, slice_id, task_id, source, confidence, files_json, created_at)
          VALUES ('0123456789abcdef0123456789abcdef01234567', 'M999', NULL, NULL, 'backfill', 0.8, '[]', '2026-05-08T00:00:00.000Z')
        `);

        // milestone_leases (FK -> milestones AND workers)
        db!.exec(`
          INSERT INTO milestone_leases (milestone_id, worker_id, fencing_token, acquired_at, expires_at, status)
          VALUES ('M999', 'w-m999', 1, '2026-05-08T00:00:00.000Z', '2026-05-08T01:00:00.000Z', 'held')
        `);

        // ─── Build a minimal manifest with a different milestone (M888) ─────
        // Empty arrays for everything else — the test cares about the
        // DELETE-then-INSERT FK behaviour, not insert coverage.
        const manifest = {
          version: 1,
          exported_at: "2026-05-08T00:00:00.000Z",
          milestones: [
            {
              id: "M888",
              title: "Restored milestone",
              status: "active",
              depends_on: [],
              created_at: "2026-05-08T00:00:00.000Z",
              completed_at: null,
              vision: "",
              success_criteria: [],
              key_risks: [],
              proof_strategy: [],
              verification_contract: "",
              verification_integration: "",
              verification_operational: "",
              verification_uat: "",
              definition_of_done: [],
              requirement_coverage: "",
              boundary_map_markdown: "",
              sequence: 0,
            },
          ],
          slices: [],
          tasks: [],
          decisions: [],
          verification_evidence: [],
        } as unknown as StateManifest;

        // bootstrapFromManifest reads from `${basePath}/.gsd/state-manifest.json`.
        mkdirSync(join(tmpDir, ".gsd"), { recursive: true });
        writeFileSync(
          join(tmpDir, ".gsd", "state-manifest.json"),
          JSON.stringify(manifest),
          "utf8",
        );

        // ─── Exercise the public bootstrap entrypoint ───────────────────────
        const ok = bootstrapFromManifest(tmpDir);
        assert.equal(ok, true, "bootstrapFromManifest must return true on success");

        // Defensive: connection must still be live post-restore.
        const dbAfter = _getCurrentDbForTests();
        assert.ok(dbAfter, "currentDb must remain non-null after bootstrapFromManifest");

        // ─── Post-state assertions ──────────────────────────────────────────
        const count = (sql: string): number => {
          const row = dbAfter!.prepare(sql).get() as { c: number } | undefined;
          return row?.c ?? -1;
        };

        assert.equal(
          count("SELECT COUNT(*) AS c FROM milestones WHERE id='M888'"),
          1,
          "M888 (from manifest) must be present",
        );
        assert.equal(
          count("SELECT COUNT(*) AS c FROM milestones WHERE id='M999'"),
          0,
          "M999 (pre-restore) must be cleared",
        );
        assert.equal(
          count("SELECT COUNT(*) AS c FROM verification_evidence"),
          0,
          "verification_evidence: manifest had none",
        );
        assert.equal(
          count("SELECT COUNT(*) AS c FROM quality_gates"),
          0,
          "quality_gates: cleared by helper",
        );
        assert.equal(
          count("SELECT COUNT(*) AS c FROM slice_dependencies"),
          0,
          "slice_dependencies: cleared by helper",
        );
        assert.equal(
          count("SELECT COUNT(*) AS c FROM assessments"),
          0,
          "assessments: cleared by helper",
        );
        assert.equal(
          count("SELECT COUNT(*) AS c FROM replan_history"),
          0,
          "replan_history: cleared by helper",
        );
        assert.equal(
          count("SELECT COUNT(*) AS c FROM milestone_commit_attributions"),
          0,
          "milestone_commit_attributions: cleared by helper",
        );
        assert.equal(
          count("SELECT COUNT(*) AS c FROM milestone_leases"),
          0,
          "milestone_leases: cleared by helper",
        );
      } finally {
        closeDatabase();
        rmSync(tmpDir, { recursive: true, force: true });
      }
    },
  );
});
