/**
 * custom-workflow-engine-rollback.test.ts — D004 reproduce-and-prevent for Bug 3
 * (M003/S05/T03): resolveDispatch must NOT mark a step active on disk if the
 * subsequent injectContext throws. Pre-fix order was markStepActive → writeGraph
 * → injectContext, leaving GRAPH.yaml in an orphan "active" state on injectContext
 * failure. Post-fix order is injectContext → markStepActive → writeGraph
 * (transactional by ordering, no rollback code needed).
 *
 * Sub-case 3A: REPRO-and-PREVENT — injectContext throws naturally because the
 *              referenced `produces` artifact path is a directory (EISDIR on
 *              readFileSync). Post-fix: GRAPH.yaml on disk shows step "pending".
 * Sub-case 3B: positive control — happy-path dispatch returns dispatch action
 *              and GRAPH.yaml shows step "active".
 * Sub-case 3C: MEM060 source-guard — regex against the source file asserts the
 *              transactional ordering literal (injectContext before markStepActive).
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stringify } from "yaml";

import { CustomWorkflowEngine } from "../custom-workflow-engine.ts";
import { writeGraph, readGraph, type WorkflowGraph } from "../graph.ts";

// ─── Helpers ─────────────────────────────────────────────────────────────

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "engine-rollback-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      /* Windows EPERM */
    }
  }
  tmpDirs.length = 0;
});

interface SetupArgs {
  /** Optional contextFrom step references for step "b" — drives injectContext path. */
  contextFromForB?: string[];
  /** Optional produces paths for step "a" — drives existsSync gate inside injectContext. */
  producesForA?: string[];
}

/**
 * Build a 2-step workflow run dir with both steps pending.
 * Step "a" is complete (so step "b" is the next-pending), step "b" depends on "a".
 * The DEFINITION.yaml shape is what injectContext reads via readFrozenDefinition.
 */
function setupTwoStepWorkflow(args: SetupArgs = {}): {
  engine: CustomWorkflowEngine;
  runDir: string;
} {
  const runDir = makeTmpDir();
  const graph: WorkflowGraph = {
    steps: [
      {
        id: "a",
        title: "step a",
        status: "complete",
        prompt: "do a",
        dependsOn: [],
      },
      {
        id: "b",
        title: "step b",
        status: "pending",
        prompt: "do b",
        dependsOn: ["a"],
      },
    ],
    metadata: { name: "rollback-wf", createdAt: "2026-01-01T00:00:00.000Z" },
  };
  writeGraph(runDir, graph);

  const def = {
    version: 1,
    name: "rollback-wf",
    steps: [
      {
        id: "a",
        name: "step a",
        prompt: "do a",
        requires: [],
        produces: args.producesForA ?? [],
      },
      {
        id: "b",
        name: "step b",
        prompt: "do b",
        requires: ["a"],
        produces: [],
        contextFrom: args.contextFromForB ?? [],
      },
    ],
  };
  writeFileSync(join(runDir, "DEFINITION.yaml"), stringify(def), "utf-8");

  return { engine: new CustomWorkflowEngine(runDir), runDir };
}

// ─── Sub-case 3A: REPRO-and-PREVENT ───────────────────────────────────────

describe("CustomWorkflowEngine.resolveDispatch — transactional injectContext ordering (Bug 3, M003/S05/T03)", () => {
  it("3A: leaves GRAPH.yaml in pending state when injectContext throws (no orphan active step)", async () => {
    // Arrange: step "a" produces a path that is a DIRECTORY (existsSync passes,
    // readFileSync throws EISDIR). Step "b" pulls context from "a" — so injectContext
    // for step "b" tries to read the directory and throws naturally.
    const { engine, runDir } = setupTwoStepWorkflow({
      producesForA: ["a-output-dir"],
      contextFromForB: ["a"],
    });
    mkdirSync(join(runDir, "a-output-dir"), { recursive: true });

    // Act + Assert: resolveDispatch must throw (injectContext bubbles EISDIR).
    await assert.rejects(
      () => engine.resolveDispatch({ phase: "running", currentMilestoneId: null, activeSliceId: null, activeTaskId: null, isComplete: false, raw: null }, { basePath: "/unused" }),
      (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        assert.match(message, /EISDIR|illegal operation on a directory/);
        return true;
      },
    );

    // CRITICAL ASSERTION: GRAPH.yaml on disk shows step "b" still PENDING — no orphan active state.
    const graphAfter = readGraph(runDir);
    const stepB = graphAfter.steps.find((s) => s.id === "b");
    assert.ok(stepB, "step b should still exist in graph");
    assert.equal(
      stepB.status,
      "pending",
      `expected step "b" status="pending" after injectContext throw — got "${stepB.status}". Pre-fix bug: orphan active state on disk.`,
    );
    // Belt + suspenders: startedAt must NOT be set (markStepActive is what stamps it).
    assert.equal(stepB.startedAt, undefined, "startedAt must be unset when markStepActive never ran");
  });

  // ─── Sub-case 3B: positive control ──────────────────────────────────────

  it("3B: happy-path dispatch — injectContext succeeds, GRAPH.yaml shows step active", async () => {
    // Arrange: no contextFrom, no produces — injectContext returns the prompt unchanged.
    const { engine, runDir } = setupTwoStepWorkflow();

    // Act
    const action = await engine.resolveDispatch(
      { phase: "running", currentMilestoneId: null, activeSliceId: null, activeTaskId: null, isComplete: false, raw: null },
      { basePath: "/unused" },
    );

    // Assert: action is dispatch, unitId points at step b, prompt is the original.
    assert.equal(action.action, "dispatch");
    if (action.action !== "dispatch") throw new Error("type narrow"); // narrow for TS
    assert.equal(action.step.unitType, "custom-step");
    assert.equal(action.step.unitId, "rollback-wf/b");
    assert.equal(action.step.prompt, "do b");

    // GRAPH.yaml on disk reflects markStepActive having run.
    const graphAfter = readGraph(runDir);
    const stepB = graphAfter.steps.find((s) => s.id === "b");
    assert.ok(stepB);
    assert.equal(stepB.status, "active");
    assert.ok(stepB.startedAt, "startedAt should be stamped");
  });

  // ─── Sub-case 3C: MEM060 source-guard ───────────────────────────────────

  it("3C: source-guard — injectContext appears BEFORE markStepActive in resolveDispatch dispatch arm", () => {
    // Read the production source file and assert the transactional ordering is preserved.
    // This regression-prevents accidental reverts of the reorder.
    const sourcePath = new URL("../custom-workflow-engine.ts", import.meta.url);
    const source = readFileSync(sourcePath, "utf-8");

    // Locate the `next` dispatch arm — anchored on the INVARIANT comment so we
    // don't accidentally match the early-return `active` arm at the top of resolveDispatch.
    const invariantIdx = source.indexOf("INVARIANT: compute injectContext BEFORE writeGraph");
    assert.ok(
      invariantIdx > 0,
      "transactional INVARIANT comment must be present in custom-workflow-engine.ts",
    );

    // Within ~30 lines after the invariant comment, injectContext(...next.id...) must
    // appear BEFORE markStepActive(...next.id...).
    const tail = source.slice(invariantIdx, invariantIdx + 2000);
    const injectIdx = tail.indexOf("injectContext(this.runDir, next.id");
    const markActiveIdx = tail.indexOf("markStepActive(graph, next.id)");
    assert.ok(injectIdx >= 0, "injectContext(this.runDir, next.id, ...) must appear in dispatch arm tail");
    assert.ok(markActiveIdx >= 0, "markStepActive(graph, next.id) must appear in dispatch arm tail");
    assert.ok(
      injectIdx < markActiveIdx,
      `injectContext must precede markStepActive in dispatch arm — got injectIdx=${injectIdx}, markActiveIdx=${markActiveIdx}`,
    );

    // Defense-in-depth: the redundant `if (!activeStep) throw` guard must be gone.
    assert.ok(
      !source.includes("Active step not found after GRAPH.yaml update"),
      "redundant post-write activeStep guard must be removed (markStepActive does not mutate id)",
    );
  });
});
