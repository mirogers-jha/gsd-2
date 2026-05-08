// GSD Auto-mode — Artifact Path Resolution
//
// resolveExpectedArtifactPath and diagnoseExpectedArtifact moved here from
// auto-recovery.ts (Phase 5 dead-code cleanup). The artifact verification
// function was removed entirely — callers now query WorkflowEngine directly.

import {
  gsdRoot,
  resolveMilestoneFile,
  resolveMilestonePath,
  resolveSliceFile,
  resolveSlicePath,
  relMilestoneFile,
  relSliceFile,
  buildMilestoneFileName,
  buildSliceFileName,
  buildTaskFileName,
} from "./paths.js";
import { parseUnitId } from "./unit-id.js";
import { join } from "node:path";
// MEM009: direct-import validators (NEVER through a barrel) — preserves
// `instanceof InvalidIdError` across module-resolution boundaries.
import {
  assertMilestoneId,
  assertSliceId,
  assertTaskId,
  InvalidIdError,
} from "./milestone-ids.js";

/**
 * Defensive entry-point guard: if `unitId` is not a string, parseUnitId would
 * crash with TypeError (`.split` on null/undefined). Surface as
 * InvalidIdError(kind=milestone) so dispatch's existing `logError` +
 * blocker-placeholder path treats it identically to a malformed milestone ID
 * — without leaking the raw TypeError up the loop.
 */
function assertUnitIdIsString(unitId: unknown, source: string): void {
  if (typeof unitId !== "string") {
    throw new InvalidIdError(
      "milestone",
      source,
      unitId === null ? "null" : unitId === undefined ? "undefined" : String(unitId),
    );
  }
}

function resolveMilestoneArtifactPath(
  base: string,
  mid: string,
  suffix: string,
): string | null {
  const existing = resolveMilestoneFile(base, mid, suffix);
  if (existing) return existing;
  const dir = resolveMilestonePath(base, mid);
  return dir ? join(dir, buildMilestoneFileName(mid, suffix)) : null;
}

function resolveSliceArtifactPath(
  base: string,
  mid: string,
  sid: string,
  suffix: string,
): string | null {
  const existing = resolveSliceFile(base, mid, sid, suffix);
  if (existing) return existing;
  const dir = resolveSlicePath(base, mid, sid);
  return dir ? join(dir, buildSliceFileName(sid, suffix)) : null;
}

/**
 * Resolve the expected artifact for a unit to an absolute path.
 */
export function resolveExpectedArtifactPath(
  unitType: string,
  unitId: string,
  base: string,
): string | null {
  assertUnitIdIsString(unitId, "auto-artifact-paths.resolveExpectedArtifactPath");
  const { milestone: mid, slice: sid, task: tid } = parseUnitId(unitId);
  switch (unitType) {
    case "workflow-preferences":
      return join(gsdRoot(base), "PREFERENCES.md");
    case "discuss-project":
      return join(gsdRoot(base), "PROJECT.md");
    case "discuss-requirements":
      return join(gsdRoot(base), "REQUIREMENTS.md");
    case "research-decision":
      return join(gsdRoot(base), "runtime", "research-decision.json");
    case "research-project":
      return join(gsdRoot(base), "research", "PROJECT-RESEARCH-BLOCKER.md");
    case "discuss-milestone": {
      assertMilestoneId(mid, "auto-artifact-paths.discuss-milestone");
      return resolveMilestoneArtifactPath(base, mid, "CONTEXT");
    }
    case "discuss-slice": {
      assertMilestoneId(mid, "auto-artifact-paths.discuss-slice");
      assertSliceId(sid!, "auto-artifact-paths.discuss-slice");
      return resolveSliceArtifactPath(base, mid, sid!, "CONTEXT");
    }
    case "research-milestone": {
      assertMilestoneId(mid, "auto-artifact-paths.research-milestone");
      return resolveMilestoneArtifactPath(base, mid, "RESEARCH");
    }
    case "plan-milestone": {
      assertMilestoneId(mid, "auto-artifact-paths.plan-milestone");
      return resolveMilestoneArtifactPath(base, mid, "ROADMAP");
    }
    case "research-slice": {
      // #4414: Sentinel unitId "{mid}/parallel-research" fans out across
      // multiple slices. Resolve to a milestone-level placeholder path so
      // blocker escalation has somewhere to write. Verification for this
      // sentinel is handled directly in verifyExpectedArtifact.
      assertMilestoneId(mid, "auto-artifact-paths.research-slice");
      // Sentinel branch MUST run before assertSliceId — `parallel-research`
      // is not a valid slice id (fails ^S\d{2}$). T01 test asserts ordering.
      if (sid === "parallel-research") {
        return resolveMilestoneArtifactPath(base, mid, "PARALLEL-BLOCKER");
      }
      assertSliceId(sid!, "auto-artifact-paths.research-slice");
      return resolveSliceArtifactPath(base, mid, sid!, "RESEARCH");
    }
    case "plan-slice": {
      assertMilestoneId(mid, "auto-artifact-paths.plan-slice");
      assertSliceId(sid!, "auto-artifact-paths.plan-slice");
      return resolveSliceArtifactPath(base, mid, sid!, "PLAN");
    }
    case "refine-slice": {
      // ADR-011: refine-slice expands a sketch and writes the same PLAN.md as plan-slice.
      assertMilestoneId(mid, "auto-artifact-paths.refine-slice");
      assertSliceId(sid!, "auto-artifact-paths.refine-slice");
      return resolveSliceArtifactPath(base, mid, sid!, "PLAN");
    }
    case "reassess-roadmap": {
      assertMilestoneId(mid, "auto-artifact-paths.reassess-roadmap");
      assertSliceId(sid!, "auto-artifact-paths.reassess-roadmap");
      return resolveSliceArtifactPath(base, mid, sid!, "ASSESSMENT");
    }
    case "run-uat": {
      assertMilestoneId(mid, "auto-artifact-paths.run-uat");
      assertSliceId(sid!, "auto-artifact-paths.run-uat");
      return resolveSliceArtifactPath(base, mid, sid!, "ASSESSMENT");
    }
    case "execute-task": {
      assertMilestoneId(mid, "auto-artifact-paths.execute-task");
      assertSliceId(sid!, "auto-artifact-paths.execute-task");
      // Validate tid as soon as it's truthy — BEFORE resolveSlicePath, so a
      // poisoned tid throws even when the slice dir doesn't yet exist on disk
      // (the security risk is the path-join, not whether the dir resolved).
      // Preserves the early-return-null-when-no-tid behavior for callers
      // that probe path resolution without a task segment.
      if (tid) assertTaskId(tid, "auto-artifact-paths.execute-task");
      const dir = resolveSlicePath(base, mid, sid!);
      return dir && tid
        ? join(dir, "tasks", buildTaskFileName(tid, "SUMMARY"))
        : null;
    }
    case "complete-slice": {
      assertMilestoneId(mid, "auto-artifact-paths.complete-slice");
      assertSliceId(sid!, "auto-artifact-paths.complete-slice");
      return resolveSliceArtifactPath(base, mid, sid!, "SUMMARY");
    }
    case "validate-milestone": {
      assertMilestoneId(mid, "auto-artifact-paths.validate-milestone");
      return resolveMilestoneArtifactPath(base, mid, "VALIDATION");
    }
    case "complete-milestone": {
      assertMilestoneId(mid, "auto-artifact-paths.complete-milestone");
      return resolveMilestoneArtifactPath(base, mid, "SUMMARY");
    }
    case "replan-slice": {
      assertMilestoneId(mid, "auto-artifact-paths.replan-slice");
      assertSliceId(sid!, "auto-artifact-paths.replan-slice");
      return resolveSliceArtifactPath(base, mid, sid!, "REPLAN");
    }
    case "rewrite-docs":
      return null;
    case "gate-evaluate":
      // Gate evaluate writes to DB quality_gates table — verified via state derivation
      return null;
    case "reactive-execute":
      // Reactive execute produces multiple task summaries — verified separately
      return null;
    default:
      return null;
  }
}

export function diagnoseExpectedArtifact(
  unitType: string,
  unitId: string,
  base: string,
): string | null {
  assertUnitIdIsString(unitId, "auto-artifact-paths.diagnoseExpectedArtifact");
  const { milestone: mid, slice: sid, task: tid } = parseUnitId(unitId);
  switch (unitType) {
    case "workflow-preferences":
      return ".gsd/PREFERENCES.md with workflow_prefs_captured: true";
    case "discuss-project":
      return ".gsd/PROJECT.md (valid project context)";
    case "discuss-requirements":
      return ".gsd/REQUIREMENTS.md (valid requirements registry)";
    case "research-decision":
      return ".gsd/runtime/research-decision.json with decision research|skip";
    case "research-project":
      return ".gsd/research/{STACK,FEATURES,ARCHITECTURE,PITFALLS}.md with at least one real research file; blocker-only outputs stop";
    case "discuss-milestone":
      assertMilestoneId(mid, "auto-artifact-paths.diagnose.discuss-milestone");
      return `${relMilestoneFile(base, mid, "CONTEXT")} (milestone context from discussion)`;
    case "discuss-slice":
      assertMilestoneId(mid, "auto-artifact-paths.diagnose.discuss-slice");
      assertSliceId(sid!, "auto-artifact-paths.diagnose.discuss-slice");
      return `${relSliceFile(base, mid, sid!, "CONTEXT")} (slice context from discussion)`;
    case "research-milestone":
      assertMilestoneId(mid, "auto-artifact-paths.diagnose.research-milestone");
      return `${relMilestoneFile(base, mid, "RESEARCH")} (milestone research)`;
    case "plan-milestone":
      assertMilestoneId(mid, "auto-artifact-paths.diagnose.plan-milestone");
      return `${relMilestoneFile(base, mid, "ROADMAP")} (milestone roadmap)`;
    case "research-slice":
      assertMilestoneId(mid, "auto-artifact-paths.diagnose.research-slice");
      if (sid === "parallel-research") {
        return `${relMilestoneFile(base, mid, "PARALLEL-BLOCKER")} (parallel slice research sentinel)`;
      }
      assertSliceId(sid!, "auto-artifact-paths.diagnose.research-slice");
      return `${relSliceFile(base, mid, sid!, "RESEARCH")} (slice research)`;
    case "plan-slice":
      assertMilestoneId(mid, "auto-artifact-paths.diagnose.plan-slice");
      assertSliceId(sid!, "auto-artifact-paths.diagnose.plan-slice");
      return `${relSliceFile(base, mid, sid!, "PLAN")} plus tasks/T##-PLAN.md files (slice plan and task plans)`;
    case "refine-slice":
      assertMilestoneId(mid, "auto-artifact-paths.diagnose.refine-slice");
      assertSliceId(sid!, "auto-artifact-paths.diagnose.refine-slice");
      return `${relSliceFile(base, mid, sid!, "PLAN")} plus tasks/T##-PLAN.md files (refined slice plan and task plans)`;
    case "execute-task": {
      assertMilestoneId(mid, "auto-artifact-paths.diagnose.execute-task");
      assertSliceId(sid!, "auto-artifact-paths.diagnose.execute-task");
      if (tid) assertTaskId(tid, "auto-artifact-paths.diagnose.execute-task");
      return `Task ${tid} marked [x] in ${relSliceFile(base, mid, sid!, "PLAN")} + summary written`;
    }
    case "complete-slice":
      assertMilestoneId(mid, "auto-artifact-paths.diagnose.complete-slice");
      assertSliceId(sid!, "auto-artifact-paths.diagnose.complete-slice");
      return `Slice ${sid} marked [x] in ${relMilestoneFile(base, mid, "ROADMAP")} + summary + UAT written`;
    case "replan-slice":
      assertMilestoneId(mid, "auto-artifact-paths.diagnose.replan-slice");
      assertSliceId(sid!, "auto-artifact-paths.diagnose.replan-slice");
      return `${relSliceFile(base, mid, sid!, "REPLAN")} + updated ${relSliceFile(base, mid, sid!, "PLAN")}`;
    case "rewrite-docs":
      return "Active overrides resolved in .gsd/OVERRIDES.md + plan documents updated";
    case "reassess-roadmap":
      assertMilestoneId(mid, "auto-artifact-paths.diagnose.reassess-roadmap");
      assertSliceId(sid!, "auto-artifact-paths.diagnose.reassess-roadmap");
      return `${relSliceFile(base, mid, sid!, "ASSESSMENT")} (roadmap reassessment)`;
    case "run-uat":
      assertMilestoneId(mid, "auto-artifact-paths.diagnose.run-uat");
      assertSliceId(sid!, "auto-artifact-paths.diagnose.run-uat");
      return `${relSliceFile(base, mid, sid!, "ASSESSMENT")} (UAT assessment result)`;
    case "validate-milestone":
      assertMilestoneId(mid, "auto-artifact-paths.diagnose.validate-milestone");
      return `${relMilestoneFile(base, mid, "VALIDATION")} (milestone validation report)`;
    case "complete-milestone":
      assertMilestoneId(mid, "auto-artifact-paths.diagnose.complete-milestone");
      return `${relMilestoneFile(base, mid, "SUMMARY")} (milestone summary)`;
    default:
      return null;
  }
}
