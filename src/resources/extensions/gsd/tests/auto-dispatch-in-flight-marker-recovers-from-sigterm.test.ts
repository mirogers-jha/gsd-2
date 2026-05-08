// GSD-2 — M002/S01/T04: auto-dispatch in-flight marker SIGTERM-mid-prompt-build
// strand + recovery contract.
//
// Pre-fix gap: the research-project rule wrapped its prompt-build call in
// try/catch, not try/finally. A throw path the catch did not cover (or any
// future code path that returned without going through the catch) would
// strand the marker forever, blocking all subsequent dispatches with a
// permanent "Project research is already in progress" stop. Additionally,
// no recovery branch existed for a marker whose owner crashed entirely
// (SIGTERM/SIGKILL) — operators had to rm the file by hand.
//
// Fix surface (auto-dispatch.ts):
//   1. Convert the prompt-build try/catch into a try/finally guarded by
//      a `dispatched` flag so EVERY non-success exit path unlinks the
//      marker (defense in depth — covers async rejections the prior
//      catch could miss).
//   2. Add a stale-marker recovery branch: when the marker exists but
//      its mtime is older than 2× PROJECT_RESEARCH_HARD_TIMEOUT_MINUTES,
//      logWarning('dispatch', 'stale in-flight marker reclaimed'),
//      unlink it, and proceed.
//
// D004 verified locally by:
//   - Reverting the try/finally to a try/catch and observing
//     "stranded marker after build throw" subtest fail.
//   - Removing the isInflightMarkerStale branch and observing
//     "stale marker reclaimed" subtest fail.

import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  DISPATCH_RULES,
  setNowFnForTest,
  setResearchProjectPromptBuilderForTest,
  type DispatchContext,
} from "../auto-dispatch.ts";
import { _resetLogs, peekLogs } from "../workflow-logger.ts";
import { PROJECT_RESEARCH_HARD_TIMEOUT_MINUTES } from "../auto-timers.ts";
import type { GSDState } from "../types.ts";
import type { GSDPreferences } from "../preferences.ts";

const RESEARCH_PROJECT_RULE_NAME = "deep: pre-planning (research approved, files missing) → research-project";

const STALE_WINDOW_MS = PROJECT_RESEARCH_HARD_TIMEOUT_MINUTES * 60_000 * 2;
const MARKER_RELPATH = join(".gsd", "runtime", "research-project-inflight");

const VALID_PROJECT_MD = [
  "# Project",
  "",
  "## What This Is",
  "",
  "A test project.",
  "",
  "## Core Value",
  "",
  "Reliable dispatch behavior.",
  "",
  "## Current State",
  "",
  "Tests are exercising the in-flight marker recovery contract.",
  "",
  "## Architecture / Key Patterns",
  "",
  "Markdown artifacts drive stage gates.",
  "",
  "## Capability Contract",
  "",
  "See `.gsd/REQUIREMENTS.md`.",
  "",
  "## Milestone Sequence",
  "",
  "- [ ] M001: Test — exercise in-flight marker recovery",
  "",
].join("\n");

const VALID_REQUIREMENTS_MD = [
  "# Requirements",
  "",
  "## Active",
  "",
  "### R001 — Marker recovery",
  "- Class: core-capability",
  "- Status: active",
  "- Description: Stranded in-flight markers must self-heal on next dispatch.",
  "- Why it matters: A leaked marker permanently blocks deep-mode auto-loops.",
  "- Source: M002/S01/T04",
  "- Primary owning slice: M002/S01",
  "- Supporting slices: none",
  "- Validation: unmapped",
  "- Notes:",
  "",
  "## Validated",
  "",
  "## Deferred",
  "",
  "## Out of Scope",
  "",
  "## Traceability",
  "",
  "| ID | Class | Status | Primary owner | Supporting | Proof |",
  "|---|---|---|---|---|---|",
  "| R001 | core-capability | active | M002/S01 | none | unmapped |",
  "",
  "## Coverage Summary",
  "",
  "- Active requirements: 1",
  "",
].join("\n");

function makeIsolatedBase(t: TestContext): string {
  const base = join(tmpdir(), `gsd-t04-marker-${randomUUID()}`);
  mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
  t.after(() => {
    try { rmSync(base, { recursive: true, force: true }); } catch {}
  });
  return base;
}

function setupReadyForResearchProject(base: string): void {
  writeFileSync(
    join(base, ".gsd", "PREFERENCES.md"),
    "---\nplanning_depth: deep\nworkflow_prefs_captured: true\n---\n",
  );
  writeFileSync(join(base, ".gsd", "PROJECT.md"), VALID_PROJECT_MD);
  writeFileSync(join(base, ".gsd", "REQUIREMENTS.md"), VALID_REQUIREMENTS_MD);
  mkdirSync(join(base, ".gsd", "runtime"), { recursive: true });
  writeFileSync(
    join(base, ".gsd", "runtime", "research-decision.json"),
    JSON.stringify({ decision: "research", source: "research-decision", decided_at: "2026-04-27T00:00:00Z" }),
  );
}

function makeCtx(basePath: string): DispatchContext {
  const state: GSDState = {
    phase: "pre-planning",
    activeMilestone: { id: "M001", title: "Test" },
    activeSlice: null,
    activeTask: null,
    recentDecisions: [],
    blockers: [],
    nextAction: "",
    registry: [{ id: "M001", title: "Test", status: "active" }],
  };
  return {
    basePath,
    mid: "M001",
    midTitle: "Test",
    state,
    prefs: { planning_depth: "deep" } as GSDPreferences,
    structuredQuestionsAvailable: "false",
  };
}

function rule(name: string) {
  const r = DISPATCH_RULES.find(x => x.name === name);
  assert.ok(r, `dispatch rule "${name}" must exist`);
  return r!;
}

// ─── Scenario 1: try/finally invariant (SIGTERM strand) ───────────────────

test("M002/S01/T04: marker is unlinked on prompt-build throw (try/finally invariant)", async (t) => {
  const base = makeIsolatedBase(t);
  setupReadyForResearchProject(base);
  const markerPath = join(base, MARKER_RELPATH);

  // Simulate SIGTERM-mid-prompt-build by injecting a throw in the
  // prompt builder. Pre-fix (try/catch), this WAS already handled,
  // but the new try/finally is the defense-in-depth contract that
  // also catches future async-rejection paths the catch would miss.
  const restore = setResearchProjectPromptBuilderForTest(async () => {
    throw new Error("SIGTERM-during-prompt-build");
  });
  t.after(restore);

  await assert.rejects(
    () => rule(RESEARCH_PROJECT_RULE_NAME).match(makeCtx(base)),
    /SIGTERM-during-prompt-build/,
  );
  assert.strictEqual(
    existsSync(markerPath),
    false,
    "throw path must unlink marker via finally — pre-fix this was a strand vector",
  );
});

test("M002/S01/T04: marker remains after successful dispatch (only closeout may clear)", async (t) => {
  const base = makeIsolatedBase(t);
  setupReadyForResearchProject(base);
  const markerPath = join(base, MARKER_RELPATH);

  const restore = setResearchProjectPromptBuilderForTest(async () => "fake-prompt");
  t.after(restore);

  const result = await rule(RESEARCH_PROJECT_RULE_NAME).match(makeCtx(base));
  assert.ok(result && result.action === "dispatch", "successful dispatch expected");
  if (result.action === "dispatch") {
    assert.strictEqual(result.unitType, "research-project");
  }
  assert.strictEqual(
    existsSync(markerPath),
    true,
    "successful dispatch must NOT unlink marker — closeout owns that",
  );
});

// ─── Scenario 2: stale-marker recovery (crashed prior run) ────────────────

test("M002/S01/T04: stale marker (older than 2× hard timeout) is reclaimed and dispatch proceeds", async (t) => {
  const base = makeIsolatedBase(t);
  setupReadyForResearchProject(base);
  const markerPath = join(base, MARKER_RELPATH);

  // Plant a stranded marker as if a prior run was SIGKILLed.
  writeFileSync(markerPath, JSON.stringify({ started: "2026-04-26T00:00:00Z" }) + "\n");

  // Backdate the marker's mtime to simulate it being older than the
  // stale window. Use utimesSync so we are not racing the test clock.
  const longAgoSec = Math.floor((Date.now() - STALE_WINDOW_MS - 60_000) / 1000);
  utimesSync(markerPath, longAgoSec, longAgoSec);

  // Sanity: confirm mtime is now in the past.
  const stats = statSync(markerPath);
  assert.ok(
    Date.now() - stats.mtimeMs > STALE_WINDOW_MS,
    "fixture: marker mtime must be older than stale window",
  );

  const restore = setResearchProjectPromptBuilderForTest(async () => "fake-prompt");
  t.after(restore);
  _resetLogs();

  const result = await rule(RESEARCH_PROJECT_RULE_NAME).match(makeCtx(base));

  assert.ok(result && result.action === "dispatch", "stale marker must be reclaimed and dispatch must proceed");
  if (result.action === "dispatch") {
    assert.strictEqual(result.unitType, "research-project");
    assert.strictEqual(result.unitId, "RESEARCH-PROJECT");
  }

  // After reclaim, a fresh marker is written for the new in-flight run.
  assert.strictEqual(existsSync(markerPath), true, "fresh marker must be planted by the new dispatch");
  const fresh = statSync(markerPath);
  assert.ok(
    Date.now() - fresh.mtimeMs < STALE_WINDOW_MS,
    "fresh marker mtime must be recent",
  );

  // Observability invariant: the reclaim must emit a warn-level log line
  // so a fresh agent reading workflow logs sees what happened. Pre-fix,
  // operators had no signal for stranded markers.
  const logs = peekLogs();
  const reclaim = logs.find(l => l.message.includes("stale in-flight marker reclaimed"));
  assert.ok(reclaim, `expected 'stale in-flight marker reclaimed' warn log; got: ${JSON.stringify(logs)}`);
  assert.strictEqual(reclaim?.severity, "warn");
  assert.strictEqual(reclaim?.component, "dispatch");
});

test("M002/S01/T04: fresh marker (within stale window) still blocks with stop action", async (t) => {
  const base = makeIsolatedBase(t);
  setupReadyForResearchProject(base);
  const markerPath = join(base, MARKER_RELPATH);

  // Fresh marker — written just now. The stale-window guard must NOT
  // reclaim a healthy in-flight marker.
  writeFileSync(markerPath, JSON.stringify({ started: new Date().toISOString() }) + "\n");

  const result = await rule(RESEARCH_PROJECT_RULE_NAME).match(makeCtx(base));
  assert.ok(result && result.action === "stop", "fresh marker must produce stop, not dispatch");
  if (result.action === "stop") {
    assert.match(result.reason, /research-project-inflight/);
  }
  assert.strictEqual(existsSync(markerPath), true, "fresh marker must remain — stop branch never unlinks");
});

// ─── Scenario 3: clock seam isolates the test from wall-clock drift ───────

test("M002/S01/T04: setNowFnForTest seam advances the staleness clock without sleeping", async (t) => {
  const base = makeIsolatedBase(t);
  setupReadyForResearchProject(base);
  const markerPath = join(base, MARKER_RELPATH);

  // Fresh marker (real wall-clock).
  writeFileSync(markerPath, JSON.stringify({ started: new Date().toISOString() }) + "\n");

  // Advance the dispatch-side clock by 3× stale window. The marker
  // mtime stays put, so the difference (nowFn - mtime) crosses the
  // staleness threshold.
  const restoreClock = setNowFnForTest(() => Date.now() + STALE_WINDOW_MS * 3);
  t.after(restoreClock);

  const restorePrompt = setResearchProjectPromptBuilderForTest(async () => "fake-prompt");
  t.after(restorePrompt);
  _resetLogs();

  const result = await rule(RESEARCH_PROJECT_RULE_NAME).match(makeCtx(base));
  assert.ok(result && result.action === "dispatch", "advanced clock must reclaim the marker");
  const reclaim = peekLogs().find(l => l.message.includes("stale in-flight marker reclaimed"));
  assert.ok(reclaim, "stale-reclaim log must be emitted via the clock seam path");
});
