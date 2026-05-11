/**
 * auto/loop.ts — Main auto-mode execution loop.
 *
 * Iterates: derive → dispatch → guards → runUnit → finalize → repeat.
 * Exits when s.active becomes false or a terminal condition is reached.
 *
 * Imports from: auto/types, auto/resolve, auto/phases
 */

import type { ExtensionAPI, ExtensionContext } from "@gsd/pi-coding-agent";

import { randomUUID } from "node:crypto";
import type { AutoSession } from "./session.js";
import type { LoopDeps } from "./loop-deps.js";
import {
  MAX_LOOP_ITERATIONS,
  type LoopState,
  type IterationContext,
  type IterationData,
} from "./types.js";
import { _clearCurrentResolve } from "./resolve.js";
import {
  runPreDispatch,
  runDispatch,
  runGuards,
  runFinalize,
} from "./phases.js";
import { debugLog } from "../debug-logger.js";
import { isInfrastructureError, isTransientCooldownError, getCooldownRetryAfterMs, COOLDOWN_FALLBACK_WAIT_MS, MAX_COOLDOWN_RETRIES } from "./infra-errors.js";
import { ModelPolicyDispatchBlockedError } from "../auto-model-selection.js";
import { resolveEngine } from "../engine-resolver.js";
import { logWarning } from "../workflow-logger.js";
import {
  recordDispatchClaim,
  markRunning as markDispatchRunning,
  markCompleted as markDispatchCompleted,
  markFailed as markDispatchFailed,
  markPolicyBlocked as markDispatchPolicyBlocked,
  getRecentForUnit as getRecentDispatchesForUnit,
  getRecentUnitKeysForProjectRoot,
} from "../db/unit-dispatches.js";
import { refreshMilestoneLease } from "../db/milestone-leases.js";
import { heartbeatAutoWorker } from "../db/auto-workers.js";
import { getRuntimeKv, setRuntimeKv } from "../db/runtime-kv.js";
import { resolveUokFlags } from "../uok/flags.js";
import { scheduleSidecarQueue } from "../uok/execution-graph.js";
import { normalizeRealPath } from "../paths.js";
import {
  buildDispatchSkipDiagnostic,
  decideCooldownRecovery,
  decideDispatchClaim,
  decideEngineDispatch,
  decideFinalizeResult,
  decideInfrastructureError,
  decideIterationErrorRecovery,
  decideMemoryPressure,
  decideModelPolicyBlocked,
  decideMinRequestInterval,
  decideWorkflowLoop,
  formatDispatchExceptionSummary,
  formatUnhandledDispatchErrorSummary,
  resolveUnitRequestTimestamp,
  shouldUseCustomEnginePath,
} from "./workflow-kernel.js";
import {
  hydrateCustomVerifyRetryCounts,
  saveCustomVerifyRetryCounts,
} from "./custom-verify-retry-store.js";
import {
  settleDispatchCompleted,
  settleDispatchFailed,
  settleDispatchPolicyBlocked,
} from "./workflow-dispatch-ledger.js";

// ─── M002/S04/T03 seam (per-bug `_setMarkDispatchFailedForTests`) ─────────────
//
// Production code MUST read `activeMarkDispatchFailed` and
// `activeMarkPolicyBlocked` on every call (no `const x = active*` closure
// capture). The plan-time grep gate
// `rg -n 'const \w+ = activeMarkDispatchFailed' src/resources/extensions/gsd/`
// MUST return zero hits.
//
// The seam wraps BOTH `markDispatchFailed` AND `markDispatchPolicyBlocked`
// because the T03 D004 test exercises the post-fix invariant by injecting a
// throwable `markDispatchPolicyBlocked` impl (verifies the helper is called)
// and a no-op `markDispatchFailed` impl (verifies the policy-blocked branch
// does NOT fall through to the `failed` settle path). Pattern mirrors T01's
// `_setAgentEndDispatcherForTests`.
type MarkDispatchFailedFn = typeof markDispatchFailed;
type MarkDispatchPolicyBlockedFn = typeof markDispatchPolicyBlocked;

const defaultMarkDispatchFailed: MarkDispatchFailedFn = markDispatchFailed;
const defaultMarkDispatchPolicyBlocked: MarkDispatchPolicyBlockedFn = markDispatchPolicyBlocked;

let activeMarkDispatchFailed: MarkDispatchFailedFn = defaultMarkDispatchFailed;
let activeMarkPolicyBlocked: MarkDispatchPolicyBlockedFn = defaultMarkDispatchPolicyBlocked;

export function _setMarkDispatchFailedForTests(impl: MarkDispatchFailedFn | null): void {
  activeMarkDispatchFailed = impl ?? defaultMarkDispatchFailed;
}

export function _resetMarkDispatchFailedForTests(): void {
  activeMarkDispatchFailed = defaultMarkDispatchFailed;
}

export function _setMarkPolicyBlockedForTests(impl: MarkDispatchPolicyBlockedFn | null): void {
  activeMarkPolicyBlocked = impl ?? defaultMarkDispatchPolicyBlocked;
}

export function _resetMarkPolicyBlockedForTests(): void {
  activeMarkPolicyBlocked = defaultMarkDispatchPolicyBlocked;
}

// ─── M002/S04/T04 seam (per-bug `_setOpenDispatchClaimForTests`) ──────────────
//
// The custom-engine path used to bypass the dispatch ledger entirely
// (RESEARCH §T04 D011 verdict: REPRODUCES by structural inspection — no
// `openDispatchClaim` call between `buildCustomEngineIterationData` and
// `runUnitPhaseViaContract`). Post-fix, BOTH the dev path AND the
// custom-engine path call `activeOpenDispatchClaim(...)` so the same
// seam exercises both branches in tests.
//
// Production code MUST read `activeOpenDispatchClaim` on every call (no
// `const x = activeOpenDispatchClaim;` closure capture). Plan-time grep
// gate `rg -n 'const \w+ = activeOpenDispatchClaim\s*[;,]'
// src/resources/extensions/gsd/` MUST return zero hits.
type OpenDispatchClaimFn = typeof openDispatchClaim;
const defaultOpenDispatchClaim: OpenDispatchClaimFn = openDispatchClaim;
let activeOpenDispatchClaim: OpenDispatchClaimFn = defaultOpenDispatchClaim;

export function _setOpenDispatchClaimForTests(impl: OpenDispatchClaimFn | null): void {
  activeOpenDispatchClaim = impl ?? defaultOpenDispatchClaim;
}

export function _resetOpenDispatchClaimForTests(): void {
  activeOpenDispatchClaim = defaultOpenDispatchClaim;
}
import { emitOpenUnitEndForUnit } from "../crash-recovery.js";
import { writeUnitRuntimeRecord } from "../unit-runtime.js";
import { openDispatchClaim } from "./workflow-dispatch-claim.js";
import { completeWorkflowIteration } from "./workflow-iteration-completion.js";
import { createWorkflowJournalReporter } from "./workflow-journal-reporter.js";
import { createWorkflowPhaseReporter } from "./workflow-phase-reporter.js";
import { createWorkflowTurnReporter } from "./workflow-turn-reporter.js";
import { validateWorkflowSessionLock } from "./workflow-session-lock.js";
import { dequeueSidecarItem } from "./workflow-sidecar-queue.js";
import { maintainWorkerHeartbeat } from "./workflow-worker-heartbeat.js";
import { measureMemoryPressure } from "./workflow-memory-pressure.js";
import { buildSidecarIterationData } from "./workflow-sidecar-iteration.js";
import {
  createExecutionGraphUnitDispatchDeps,
  runUnitPhaseViaContract,
  type DispatchContract,
} from "./workflow-unit-dispatch.js";
import { handleCustomEngineDispatchOutcome } from "./workflow-custom-engine-dispatch-outcome.js";
import { buildCustomEngineIterationData } from "./workflow-custom-engine-iteration.js";
import { handleCustomEngineVerifyRetry } from "./workflow-custom-engine-retry.js";
import {
  handleCustomEngineVerifyPause,
  handleCustomEngineVerifyRetryOutcome,
} from "./workflow-custom-engine-verify-outcome.js";
import { handleCustomEngineReconcile } from "./workflow-custom-engine-reconcile.js";
import { handleCustomEngineReconcileOutcome } from "./workflow-custom-engine-reconcile-outcome.js";

// ── Stuck detection persistence (#3704) ──────────────────────────────────
// Phase C migration: stuck-state.json deleted in favor of DB-backed
// equivalents. recentUnits is rebuilt from unit_dispatches (Phase B
// ledger) on session start; stuckRecoveryAttempts persists in runtime_kv
// under a stable project scope (soft state per the runtime_kv invariant). Single-host
// SQLite WAL only — multi-host would need a real coordinator.
//
// When no worker is registered (DB unavailable, fresh project), both
// helpers degrade to the empty-state fallback that #3704 already
// tolerates — same behavior as a fresh session.
const STUCK_RECOVERY_ATTEMPTS_KEY = "stuck_recovery_attempts";
const RECENT_UNIT_KEYS_LIMIT = 20;

function stableStuckStateScopeId(s: AutoSession): string {
  return normalizeRealPath(s.scope?.workspace.projectRoot ?? (s.originalBasePath || s.basePath));
}

function loadStuckState(s: AutoSession): { recentUnits: Array<{ key: string }>; stuckRecoveryAttempts: number } {
  const scopeId = stableStuckStateScopeId(s);
  if (!scopeId) return { recentUnits: [], stuckRecoveryAttempts: 0 };
  try {
    const recentUnits = getRecentUnitKeysForProjectRoot(scopeId, RECENT_UNIT_KEYS_LIMIT);
    const stuckRecoveryAttempts =
      getRuntimeKv<number>("global", scopeId, STUCK_RECOVERY_ATTEMPTS_KEY) ?? 0;
    return { recentUnits, stuckRecoveryAttempts };
  } catch (err) {
    debugLog("autoLoop", { phase: "load-stuck-state-failed", error: err instanceof Error ? err.message : String(err) });
    return { recentUnits: [], stuckRecoveryAttempts: 0 };
  }
}

function saveStuckState(s: AutoSession, state: LoopState): void {
  const scopeId = stableStuckStateScopeId(s);
  if (!scopeId) return;
  // recentUnits is automatically derived from unit_dispatches by the
  // dispatch ledger writes in openDispatchClaim — no separate persistence
  // needed. Only the soft retry counter needs a runtime_kv row.
  try {
    setRuntimeKv("global", scopeId, STUCK_RECOVERY_ATTEMPTS_KEY, state.stuckRecoveryAttempts);
  } catch (err) {
    debugLog("autoLoop", { phase: "save-stuck-state-failed", error: err instanceof Error ? err.message : String(err) });
  }
}

function logDispatchLedgerWriteFailure(err: unknown): void {
  debugLog("autoLoop", {
    phase: "dispatch-ledger-write-failed",
    error: err instanceof Error ? err.message : String(err),
  });
}

function logDispatchClaimRejected(details: {
  unitId: string;
  reason: string;
  existingId?: number;
  existingWorker?: string;
}): void {
  debugLog("autoLoop", {
    phase: "dispatch-claim-rejected",
    ...details,
  });
}

function logDispatchClaimFailed(err: unknown): void {
  debugLog("autoLoop", {
    phase: "dispatch-claim-failed",
    error: err instanceof Error ? err.message : String(err),
  });
}

function logCustomVerifyRetryLoadFailure(err: unknown): void {
  debugLog("autoLoop", {
    phase: "load-custom-verify-retries-failed",
    error: err instanceof Error ? err.message : String(err),
  });
}

function logCustomVerifyRetrySaveFailure(err: unknown): void {
  debugLog("autoLoop", {
    phase: "save-custom-verify-retries-failed",
    error: err instanceof Error ? err.message : String(err),
  });
}

// ── Memory pressure monitoring (#3331) ──────────────────────────────────
// Check heap usage every N iterations and trigger graceful shutdown before
// the OS OOM killer sends SIGKILL. The threshold is 90% of the V8 heap
// limit (--max-old-space-size or default ~1.5-4GB depending on platform).
const MEMORY_CHECK_INTERVAL = 5; // check every 5 iterations
const MAX_CUSTOM_ENGINE_VERIFY_RETRIES = 3;

interface AutoLoopOptions {
  dispatchContract?: DispatchContract;
}

async function enforceMinRequestInterval(s: AutoSession, prefs: IterationContext["prefs"]): Promise<void> {
  const minInterval = prefs?.min_request_interval_ms ?? 0;
  const decision = decideMinRequestInterval({
    minIntervalMs: minInterval,
    lastRequestTimestamp: s.lastRequestTimestamp,
    nowMs: Date.now(),
  });
  if (decision.action === "wait") {
    debugLog("autoLoop", { phase: "rate-limit-wait", waitMs: decision.waitMs });
    await new Promise<void>(r => setTimeout(r, decision.waitMs));
  }
}

function closeOutCrashedUnit(s: AutoSession, iterData: IterationData, err: unknown): void {
  const summary = formatDispatchExceptionSummary({ error: err });
  try {
    emitOpenUnitEndForUnit(
      s.basePath,
      iterData.unitType,
      iterData.unitId,
      "cancelled",
      {
        message: summary,
        category: "unit-exception",
        isTransient: false,
      },
    );
    writeUnitRuntimeRecord(
      s.basePath,
      iterData.unitType,
      iterData.unitId,
      s.currentUnit?.startedAt ?? Date.now(),
      {
        phase: "crashed",
        lastProgressAt: Date.now(),
        lastProgressKind: "unit-exception",
      },
    );
  } catch (closeoutErr) {
    logWarning("dispatch", `unit crash closeout failed: ${closeoutErr instanceof Error ? closeoutErr.message : String(closeoutErr)}`);
  }
}

/**
 * Main auto-mode execution loop. Iterates: derive → dispatch → guards →
 * runUnit → finalize → repeat. Exits when s.active becomes false or a
 * terminal condition is reached.
 *
 * This is the linear replacement for the recursive
 * dispatchNextUnit → resolveAgentEnd → dispatchNextUnit chain.
 */
export async function autoLoop(
  ctx: ExtensionContext,
  pi: ExtensionAPI,
  s: AutoSession,
  deps: LoopDeps,
  options?: AutoLoopOptions,
): Promise<void> {
  debugLog("autoLoop", { phase: "enter" });
  let iteration = 0;
  const dispatchContract = options?.dispatchContract ?? "legacy-direct";
  const unitDispatchDeps = createExecutionGraphUnitDispatchDeps();
  // Load persisted stuck state so counters survive session restarts (#3704)
  const persisted = loadStuckState(s);
  const loopState: LoopState = {
    recentUnits: persisted.recentUnits,
    stuckRecoveryAttempts: persisted.stuckRecoveryAttempts,
    consecutiveFinalizeTimeouts: 0,
  };
  let consecutiveErrors = 0;
  let consecutiveCooldowns = 0;
  const recentErrorMessages: string[] = [];

  while (s.active) {
    iteration++;
    debugLog("autoLoop", { phase: "loop-top", iteration });

    maintainWorkerHeartbeat(s, {
      heartbeatAutoWorker,
      refreshMilestoneLease,
      logHeartbeatFailure: err => debugLog("autoLoop", {
        phase: "heartbeat-failed",
        error: err instanceof Error ? err.message : String(err),
      }),
    });

    // ── Journal: per-iteration flow grouping ──
    const flowId = randomUUID();
    let seqCounter = 0;
    const nextSeq = () => ++seqCounter;
    const journalReporter = createWorkflowJournalReporter({
      emitJournalEvent: deps.emitJournalEvent,
      flowId,
      nextSeq,
    });
    const turnId = randomUUID();
    s.currentTraceId = flowId;
    s.currentTurnId = turnId;
    const turnStartedAt = new Date().toISOString();
    let observedUnitType: string | undefined;
    let observedUnitId: string | undefined;
    const phaseReporter = createWorkflowPhaseReporter({
      observer: deps.uokObserver,
    });
    const turnReporter = createWorkflowTurnReporter({
      observer: deps.uokObserver,
      traceId: flowId,
      turnId,
      iteration,
      basePath: s.basePath,
      startedAt: turnStartedAt,
      clearCurrentTurn: () => {
        s.currentTraceId = null;
        s.currentTurnId = null;
      },
    });
    const finishTurn = (
      status: "completed" | "failed" | "paused" | "stopped" | "skipped" | "retry",
      failureClass: "none" | "unknown" | "manual-attention" | "timeout" | "execution" | "closeout" | "git" = "none",
      error?: string,
    ): void => {
      turnReporter.finish({
        unitType: observedUnitType,
        unitId: observedUnitId,
        status,
        failureClass,
        error,
      });
    };
    turnReporter.start();

    const iterationDecision = decideWorkflowLoop({
      active: s.active,
      iteration,
      maxIterations: MAX_LOOP_ITERATIONS,
      hasCommandContext: true,
      sessionLockValid: true,
    });
    if (iterationDecision.action === "stop" && iterationDecision.reason === "max-iterations") {
      debugLog("autoLoop", {
        phase: "exit",
        reason: iterationDecision.reason,
        iteration,
      });
      await deps.stopAuto(
        ctx,
        pi,
        `Safety: loop exceeded ${MAX_LOOP_ITERATIONS} iterations — possible runaway`,
      );
      finishTurn("stopped", "manual-attention", "max-iterations");
      break;
    }

    // ── Memory pressure check (#3331) ──
    // Graceful shutdown before OOM killer sends SIGKILL.
    if (iteration % MEMORY_CHECK_INTERVAL === 0) {
      const mem = measureMemoryPressure();
      debugLog("autoLoop", { phase: "memory-check", ...mem });
      const memoryDecision = decideMemoryPressure({ ...mem, iteration });
      if (memoryDecision.action === "stop") {
        logWarning("dispatch", memoryDecision.warningMessage);
        await deps.stopAuto(ctx, pi, memoryDecision.stopMessage);
        finishTurn("stopped", "timeout", memoryDecision.turnError);
        break;
      }
    }

    const commandContextDecision = decideWorkflowLoop({
      active: s.active,
      iteration,
      maxIterations: MAX_LOOP_ITERATIONS,
      hasCommandContext: Boolean(s.cmdCtx),
      sessionLockValid: true,
    });
    if (commandContextDecision.action === "stop" && commandContextDecision.reason === "missing-command-context") {
      debugLog("autoLoop", { phase: "exit", reason: "no-cmdCtx" });
      finishTurn("stopped", "manual-attention", commandContextDecision.reason);
      break;
    }

    let dispatchId: number | null = null;
    let dispatchSettled = false;
    const completeIteration = (): void => {
      completeWorkflowIteration({
        get consecutiveErrors() { return consecutiveErrors; },
        set consecutiveErrors(value) { consecutiveErrors = value; },
        get consecutiveCooldowns() { return consecutiveCooldowns; },
        set consecutiveCooldowns(value) { consecutiveCooldowns = value; },
        recentErrorMessages,
      }, {
        emitIterationEnd: () => journalReporter.emit("iteration-end", { iteration }),
        saveStuckState: () => saveStuckState(s, loopState),
        logIterationComplete: () => debugLog("autoLoop", { phase: "iteration-complete", iteration }),
      });
    };

    try {
      // ── Blanket try/catch: one bad iteration must not kill the session
      const prefs = deps.loadEffectiveGSDPreferences()?.preferences;
      const uokFlags = resolveUokFlags(prefs);

      // ── Check sidecar queue before deriveState ──
      // NOTE: Sidecar dequeue MUST run before validateWorkflowSessionLock so a
      // queued item is popped (and the `sidecar-dequeue` journal event emitted)
      // even when the session lock invalidates this iteration. Inverting this
      // order silently drops queued items on lock-loss. Refs #5308.
      const sidecarItem = await dequeueSidecarItem({
        queue: s.sidecarQueue,
        executionGraphEnabled: uokFlags.executionGraph,
        scheduleQueue: scheduleSidecarQueue,
        warnSchedulingFailure: message => logWarning("dispatch", `sidecar queue scheduling failed: ${message}`),
        logDequeue: payload => debugLog("autoLoop", { phase: "sidecar-dequeue", ...payload }),
        emitDequeue: payload => journalReporter.emit("sidecar-dequeue", payload),
      });

      const sessionLockOutcome = validateWorkflowSessionLock({
        active: s.active,
        iteration,
        maxIterations: MAX_LOOP_ITERATIONS,
        deps: {
          lockBase: deps.lockBase,
          validateSessionLock: deps.validateSessionLock,
          handleLostSessionLock: lockStatus => deps.handleLostSessionLock(ctx, lockStatus),
          logInvalidSessionLock: details => debugLog("autoLoop", {
            phase: "session-lock-invalid",
            ...details,
          }),
          logSessionLockExit: details => debugLog("autoLoop", {
            phase: "exit",
            ...details,
          }),
        },
      });
      if (sessionLockOutcome.action === "stop" && sessionLockOutcome.reason === "session-lock-lost") {
        finishTurn("stopped", "manual-attention", sessionLockOutcome.reason);
        break;
      }

      const ic: IterationContext = { ctx, pi, s, deps, prefs, iteration, flowId, nextSeq };
      journalReporter.emit("iteration-start", { iteration });
      let iterData: IterationData;

      // ── Custom engine path ──────────────────────────────────────────────
      // When activeEngineId is a non-dev value, bypass runPreDispatch and
      // runDispatch entirely — the custom engine drives its own state via
      // GRAPH.yaml. Shares runGuards and runUnitPhase with the dev path.
      // After unit execution, verifies then reconciles via the engine layer.
      //
      // GSD_ENGINE_BYPASS=1 skips the engine layer entirely — falls through
      // to the dev path below.
      if (shouldUseCustomEnginePath({
        activeEngineId: s.activeEngineId,
        hasSidecarItem: Boolean(sidecarItem),
        engineBypass: process.env.GSD_ENGINE_BYPASS === "1",
      })) {
        debugLog("autoLoop", { phase: "custom-engine-derive", iteration, engineId: s.activeEngineId });

        const { engine, policy } = resolveEngine({
          activeEngineId: s.activeEngineId,
          activeRunDir: s.activeRunDir,
        });

        const engineState = await engine.deriveState(s.canonicalProjectRoot);
        debugLog("autoLoop", {
          phase: "post-derive",
          site: "custom-engine-derive",
          basePath: s.basePath,
          originalBasePath: s.originalBasePath,
          scopeProjectRoot: s.scope?.workspace.projectRoot,
          canonicalProjectRoot: s.canonicalProjectRoot,
          derivedPhase: (engineState as { phase?: string }).phase,
          isComplete: engineState.isComplete,
        });
        if (engineState.isComplete) {
          finishTurn("completed");
          await deps.stopAuto(ctx, pi, "Workflow complete");
          break;
        }

        debugLog("autoLoop", { phase: "custom-engine-dispatch", iteration });
        const dispatch = await engine.resolveDispatch(engineState, { basePath: s.basePath });
        const engineDispatchDecision = decideEngineDispatch(dispatch.action === "stop"
          ? { action: "stop", reason: dispatch.reason }
          : { action: dispatch.action });
        const dispatchFlow = await handleCustomEngineDispatchOutcome({
          decision: engineDispatchDecision,
          deps: {
            stopAuto: reason => deps.stopAuto(ctx, pi, reason),
          },
        });
        if (dispatchFlow.action === "break") {
          finishTurn("stopped", "manual-attention", "custom-engine-dispatch-stop");
          break;
        }
        if (dispatchFlow.action === "continue") {
          finishTurn("skipped");
          continue;
        }

        // dispatch.action === "dispatch"
        if (dispatch.action !== "dispatch") {
          finishTurn("skipped");
          continue;
        }
        const step = dispatch.step;
        iterData = await buildCustomEngineIterationData({
          step,
          basePath: s.basePath,
          canonicalProjectRoot: s.canonicalProjectRoot,
          currentMilestoneId: s.currentMilestoneId,
          deriveState: deps.deriveState,
          logPostDerive: details => debugLog("autoLoop", {
            phase: "post-derive",
            ...details,
          }),
        });
        observedUnitType = iterData.unitType;
        observedUnitId = iterData.unitId;

        // ── Progress widget (mirrors dev path in runDispatch) ──
        deps.updateProgressWidget(ctx, iterData.unitType, iterData.unitId, iterData.state);

        // ── Guards (shared with dev path) ──
        const guardsResult = await runGuards(ic, s.currentMilestoneId ?? "workflow");
        phaseReporter.report("guard", guardsResult.action, {
          unitType: iterData.unitType,
          unitId: iterData.unitId,
        });
        if (guardsResult.action === "break") {
          finishTurn("stopped", "manual-attention", "guard-break");
          break;
        }

        // ── Unit execution (shared with dev path) ──
        await enforceMinRequestInterval(s, prefs);

        // M002/S04/T04 — open dispatch claim BEFORE runUnitPhaseViaContract
        // so custom-engine dispatches participate in the same FK-protected
        // unit_dispatches ledger as dev-path dispatches. Pre-fix this branch
        // bypassed the ledger entirely (RESEARCH §T04 D011 verdict:
        // REPRODUCES by structural inspection — `openDispatchClaim` was
        // missing). Routes through `activeOpenDispatchClaim` so the
        // `_setOpenDispatchClaimForTests` seam exercises both this branch
        // AND the dev-path branch with a single per-bug seam.
        //
        // Mirrors the dev-path block at the lower call site verbatim,
        // including `decideDispatchClaim` + the `dispatchDecision.action ===
        // "skip"` diagnostic + journal emit + UI notification (Bug B2 fix
        // is shared). Assigns `dispatchId` to the iteration-scoped variable
        // so the existing blanket catch (M002/S04/T03) settles the row on
        // any throw from `runUnitPhaseViaContract` or downstream.
        const customEngineDispatchClaim = activeOpenDispatchClaim(s, flowId, turnId, iterData, {
          getRecentDispatchesForUnit,
          recordDispatchClaim,
          markDispatchRunning,
          logClaimRejected: logDispatchClaimRejected,
          logClaimFailed: logDispatchClaimFailed,
        });
        const customEngineDispatchDecision = decideDispatchClaim(
          customEngineDispatchClaim.kind === "opened"
            ? { kind: "opened", dispatchId: customEngineDispatchClaim.dispatchId }
            : customEngineDispatchClaim.kind === "skip"
              ? { kind: "skip", reason: customEngineDispatchClaim.reason }
              : { kind: "degraded" },
        );
        if (customEngineDispatchDecision.action === "skip") {
          // Same Bug B2 diagnostic shape as dev path (silent dispatch-skip
          // observability gap). RESEARCH §T04 confirmed both branches
          // share the same skip-handling contract.
          const diagnostic = buildDispatchSkipDiagnostic({
            unitType: iterData.unitType,
            unitId: iterData.unitId,
            reason: customEngineDispatchDecision.reason,
            existingDispatchId:
              customEngineDispatchClaim.kind === "skip"
                ? customEngineDispatchClaim.existingId
                : undefined,
            existingWorker:
              customEngineDispatchClaim.kind === "skip"
                ? customEngineDispatchClaim.existingWorker
                : undefined,
          });
          deps.emitJournalEvent({
            ts: new Date().toISOString(),
            flowId,
            seq: nextSeq(),
            eventType: "dispatch-skip",
            data: diagnostic.journalPayload,
          });
          ctx.ui.notify(diagnostic.message, "warning");
          finishTurn("skipped", "execution", customEngineDispatchDecision.reason);
          continue;
        }
        // action === "run". `dispatchId` may be null when openDispatchClaim
        // returned `{ kind: "degraded" }` (DB unavailable / no worker /
        // no active lease) — `decideDispatchClaim` collapses that into
        // `{ action: "run", dispatchId: null }` so the loop continues with
        // back-compat single-worker semantics. Emit a single warning so
        // forensics can spot when custom-engine units run without a ledger
        // row.
        dispatchId = customEngineDispatchDecision.dispatchId;
        if (dispatchId === null) {
          logWarning(
            "dispatch",
            "custom-engine dispatch ledger row missing — claim-helper failed (degraded back-compat path)",
            { unitType: iterData.unitType, unitId: iterData.unitId },
          );
        }

        let unitPhaseResult: Awaited<ReturnType<typeof runUnitPhaseViaContract>>;
        try {
          unitPhaseResult = await runUnitPhaseViaContract(
            dispatchContract,
            ic,
            iterData,
            loopState,
            undefined,
            unitDispatchDeps,
          );
        } catch (err) {
          if (err instanceof ModelPolicyDispatchBlockedError) {
            throw err;
          }
          closeOutCrashedUnit(s, iterData, err);
          throw err;
        }
        if (unitPhaseResult.action === "next") {
          const requestTimestamp = resolveUnitRequestTimestamp(unitPhaseResult.data);
          if (requestTimestamp !== undefined) s.lastRequestTimestamp = requestTimestamp;
        }
        phaseReporter.report("unit", unitPhaseResult.action, {
          unitType: iterData.unitType,
          unitId: iterData.unitId,
        });
        if (unitPhaseResult.action === "break") {
          finishTurn("stopped", "execution", "unit-break");
          break;
        }

        // ── Verify first, then reconcile (only mark complete on pass) ──
        debugLog("autoLoop", { phase: "custom-engine-verify", iteration, unitId: iterData.unitId });
        const verifyResult = await policy.verify(iterData.unitType, iterData.unitId, { basePath: s.basePath });
        if (verifyResult === "pause") {
          const verifyFlow = await handleCustomEngineVerifyPause({
            unitType: iterData.unitType,
            unitId: iterData.unitId,
            deps: {
              pauseAuto: () => deps.pauseAuto(ctx, pi),
              stopAuto: reason => deps.stopAuto(ctx, pi, reason),
              reportPause: details => phaseReporter.report("custom-engine", "pause", details),
              finishTurn,
            },
          });
          if (verifyFlow.action === "break") break;
        }
        if (verifyResult === "retry") {
          const retryOutcome = await handleCustomEngineVerifyRetry({
            session: s,
            unitType: iterData.unitType,
            unitId: iterData.unitId,
            basePath: s.basePath,
            iteration,
            maxRetries: MAX_CUSTOM_ENGINE_VERIFY_RETRIES,
            deps: {
              hydrateRetryCounts: () => hydrateCustomVerifyRetryCounts(s, {
                logFailure: logCustomVerifyRetryLoadFailure,
              }),
              saveRetryCounts: () => saveCustomVerifyRetryCounts(s, {
                logFailure: logCustomVerifyRetrySaveFailure,
              }),
              recover: (unitType, unitId, options) => policy.recover(unitType, unitId, options),
              logRetry: details => debugLog("autoLoop", {
                phase: "custom-engine-verify-retry",
                ...details,
              }),
              reportRetry: details => phaseReporter.report("custom-engine", "retry", details),
            },
          });
          const retryFlow = await handleCustomEngineVerifyRetryOutcome({
            outcome: retryOutcome,
            deps: {
              pauseAuto: () => deps.pauseAuto(ctx, pi),
              stopAuto: reason => deps.stopAuto(ctx, pi, reason),
              reportPause: details => phaseReporter.report("custom-engine", "pause", details),
              finishTurn,
            },
          });
          if (retryFlow.action === "break") break;
          continue;
        }

        // Verification passed — mark step complete
        const reconcileOutcome = await handleCustomEngineReconcile({
          session: s,
          engineState,
          iterData,
          iteration,
          deps: {
            saveRetryCounts: () => saveCustomVerifyRetryCounts(s, {
              logFailure: logCustomVerifyRetrySaveFailure,
            }),
            logReconcile: details => debugLog("autoLoop", {
              phase: "custom-engine-reconcile",
              ...details,
            }),
            reconcile: (state, completedStep) => engine.reconcile(state, completedStep),
            now: () => Date.now(),
            clearUnitTimeout: deps.clearUnitTimeout,
            completeIteration,
          },
        });
        const reconcileFlow = await handleCustomEngineReconcileOutcome({
          outcome: reconcileOutcome,
          unitType: iterData.unitType,
          unitId: iterData.unitId,
          deps: {
            stopAuto: reason => deps.stopAuto(ctx, pi, reason),
            pauseAuto: () => deps.pauseAuto(ctx, pi),
            report: (action, details) => phaseReporter.report("custom-engine", action, details),
            finishTurn,
          },
        });
        if (reconcileFlow.action === "break") break;
        // M002/S04/T04 — settle the dispatch row to `completed` on the
        // verify-passed + reconciled-successfully success path. Without this
        // settle, custom-engine ledger rows would remain in `running` until
        // the blanket catch (T03) or crash recovery cleared them. Mirrors
        // the dev path's `settleDispatchCompleted` call inside `runFinalize`.
        // No-op when `dispatchId` is null (degraded path emitted a warning
        // above; row was never opened).
        dispatchSettled = settleDispatchCompleted(dispatchId, {
          markCompleted: markDispatchCompleted,
          logWriteFailure: logDispatchLedgerWriteFailure,
        }) || dispatchSettled;
        continue;
      }

      if (!sidecarItem) {
        // ── Phase 1: Pre-dispatch ─────────────────────────────────────────
        const preDispatchResult = await runPreDispatch(ic, loopState);
        phaseReporter.report("pre-dispatch", preDispatchResult.action);
        if (preDispatchResult.action === "break") {
          finishTurn("stopped", "manual-attention", "pre-dispatch-break");
          break;
        }
        if (preDispatchResult.action === "continue") {
          finishTurn("skipped");
          continue;
        }

        const preData = preDispatchResult.data;

        // ── Phase 2: Guards ───────────────────────────────────────────────
        const guardsResult = await runGuards(ic, preData.mid);
        phaseReporter.report("guard", guardsResult.action);
        if (guardsResult.action === "break") {
          finishTurn("stopped", "manual-attention", "guard-break");
          break;
        }

        // ── Phase 3: Dispatch ─────────────────────────────────────────────
        const dispatchResult = await runDispatch(ic, preData, loopState);
        phaseReporter.report("dispatch", dispatchResult.action);
        if (dispatchResult.action === "break") {
          finishTurn("stopped", "manual-attention", "dispatch-break");
          break;
        }
        if (dispatchResult.action === "continue") {
          finishTurn("skipped");
          continue;
        }
        iterData = dispatchResult.data;
        observedUnitType = iterData.unitType;
        observedUnitId = iterData.unitId;
      } else {
        iterData = await buildSidecarIterationData({
          sidecarItem,
          basePath: s.basePath,
          canonicalProjectRoot: s.canonicalProjectRoot,
          deriveState: deps.deriveState,
          logPostDerive: details => debugLog("autoLoop", {
            phase: "post-derive",
            ...details,
          }),
        });
        observedUnitType = iterData.unitType;
        observedUnitId = iterData.unitId;
        phaseReporter.report("dispatch", "sidecar", {
          unitType: iterData.unitType,
          unitId: iterData.unitId,
          sidecarKind: sidecarItem.kind,
        });
      }

      await enforceMinRequestInterval(s, prefs);

      // Phase B: claim a unit_dispatches row before invoking the unit. The
      // partial unique index idx_unit_dispatches_active_per_unit prevents
      // a second worker from claiming the same unit concurrently. Returns
      // null when DB unavailable, no worker registered, or no active lease
      // — those degraded paths fall through to the existing single-worker
      // semantics with no ledger entry, preserving back-compat.
      // M002/S04/T04 — routed through `activeOpenDispatchClaim` so the
      // per-bug seam can deterministically interleave both this dev-path
      // call AND the new custom-engine-branch call (RESEARCH §T04).
      const dispatchClaim = activeOpenDispatchClaim(s, flowId, turnId, iterData, {
        getRecentDispatchesForUnit,
        recordDispatchClaim,
        markDispatchRunning,
        logClaimRejected: logDispatchClaimRejected,
        logClaimFailed: logDispatchClaimFailed,
      });
      const dispatchDecision = decideDispatchClaim(
        dispatchClaim.kind === "opened"
          ? { kind: "opened", dispatchId: dispatchClaim.dispatchId }
          : dispatchClaim.kind === "skip"
            ? { kind: "skip", reason: dispatchClaim.reason }
            : { kind: "degraded" },
      );
      if (dispatchDecision.action === "skip") {
        // Bug B2 — silent dispatch-skip observability gap.
        //
        // Pre-fix this branch did `finishTurn("skipped"); continue;` with no
        // journal event and no UI notification. Combined with Bug B1 (crash
        // recovery leaving stuck `running` rows), the user saw the loop
        // burn through iterations with `iteration-start → dispatch-match →
        // ø` and zero diagnostic, eventually tripping the "derived 3
        // consecutive times without progress" stuck guard with the wrong
        // root cause.
        //
        // Post-fix delegates message + payload construction to the pure
        // helper `buildDispatchSkipDiagnostic` (testable in isolation), then
        // emits a structured `dispatch-skip` journal event and a user-facing
        // notification.
        const diagnostic = buildDispatchSkipDiagnostic({
          unitType: iterData.unitType,
          unitId: iterData.unitId,
          reason: dispatchDecision.reason,
          existingDispatchId:
            dispatchClaim.kind === "skip" ? dispatchClaim.existingId : undefined,
          existingWorker:
            dispatchClaim.kind === "skip" ? dispatchClaim.existingWorker : undefined,
        });
        deps.emitJournalEvent({
          ts: new Date().toISOString(),
          flowId,
          seq: nextSeq(),
          eventType: "dispatch-skip",
          data: diagnostic.journalPayload,
        });
        ctx.ui.notify(diagnostic.message, "warning");
        finishTurn("skipped", "execution", dispatchDecision.reason);
        continue;
      }
      dispatchId = dispatchDecision.dispatchId;

      let unitPhaseResult: Awaited<ReturnType<typeof runUnitPhaseViaContract>>;
      try {
        unitPhaseResult = await runUnitPhaseViaContract(
          dispatchContract,
          ic,
          iterData,
          loopState,
          sidecarItem,
          unitDispatchDeps,
        );
      } catch (err) {
        if (err instanceof ModelPolicyDispatchBlockedError) {
          throw err;
        }
        closeOutCrashedUnit(s, iterData, err);
        dispatchSettled = settleDispatchFailed(
          dispatchId,
          formatDispatchExceptionSummary({ error: err }),
          {
            markFailed: markDispatchFailed,
            logWriteFailure: logDispatchLedgerWriteFailure,
          },
        ) || dispatchSettled;
        throw err;
      }
      if (unitPhaseResult.action === "next") {
        const requestTimestamp = resolveUnitRequestTimestamp(unitPhaseResult.data);
        if (requestTimestamp !== undefined) s.lastRequestTimestamp = requestTimestamp;
      }
      phaseReporter.report("unit", unitPhaseResult.action, {
        unitType: iterData.unitType,
        unitId: iterData.unitId,
      });
      if (unitPhaseResult.action === "break") {
        dispatchSettled = settleDispatchFailed(dispatchId, "unit-break", {
          markFailed: markDispatchFailed,
          logWriteFailure: logDispatchLedgerWriteFailure,
        }) || dispatchSettled;
        finishTurn("stopped", "execution", "unit-break");
        break;
      }

      // ── Phase 5: Finalize ───────────────────────────────────────────────

      let finalizeResult: Awaited<ReturnType<typeof runFinalize>>;
      try {
        finalizeResult = await runFinalize(ic, iterData, loopState, sidecarItem);
      } catch (err) {
        dispatchSettled = settleDispatchFailed(
          dispatchId,
          formatDispatchExceptionSummary({ error: err }),
          {
            markFailed: markDispatchFailed,
            logWriteFailure: logDispatchLedgerWriteFailure,
          },
        ) || dispatchSettled;
        throw err;
      }
      phaseReporter.report("finalize", finalizeResult.action, {
        unitType: iterData.unitType,
        unitId: iterData.unitId,
      });
      const finalizeDecision = decideFinalizeResult(
        finalizeResult.action === "break"
          ? { action: "break", reason: finalizeResult.reason }
          : finalizeResult.action === "continue"
            ? { action: "continue" }
            : { action: "next" },
      );
      if (finalizeDecision.action === "stop") {
        dispatchSettled = settleDispatchFailed(dispatchId, finalizeDecision.ledgerErrorSummary, {
          markFailed: markDispatchFailed,
          logWriteFailure: logDispatchLedgerWriteFailure,
        }) || dispatchSettled;
        finishTurn("stopped", finalizeDecision.failureClass, finalizeDecision.turnError);
        break;
      }
      if (finalizeDecision.action === "retry") {
        dispatchSettled = settleDispatchFailed(dispatchId, finalizeDecision.ledgerErrorSummary, {
          markFailed: markDispatchFailed,
          logWriteFailure: logDispatchLedgerWriteFailure,
        }) || dispatchSettled;
        finishTurn("retry");
        continue;
      }

      dispatchSettled = settleDispatchCompleted(dispatchId, {
        markCompleted: markDispatchCompleted,
        logWriteFailure: logDispatchLedgerWriteFailure,
      }) || dispatchSettled;
      completeIteration();
      finishTurn("completed");
    } catch (loopErr) {
      // ── Blanket catch: absorb unexpected exceptions, apply graduated recovery ──
      const msg = loopErr instanceof Error ? loopErr.message : String(loopErr);
      // M002/S04/T03 fix — policy-blocked errors used to be EXCLUDED from
      // ledger-settle here so the row stayed in `running` until manual
      // cleanup (RESEARCH §T03 D011 verdict: REPRODUCES). Post-fix: route
      // policy-blocked errors through `settleDispatchPolicyBlocked` to write
      // the new terminal `policy-blocked` status; route everything else
      // through `settleDispatchFailed` as before. Both paths use the
      // `_setMarkDispatchFailedForTests` / `_setMarkPolicyBlockedForTests`
      // seams so the D004 test can deterministically assert which branch
      // fired.
      if (dispatchId !== null && !dispatchSettled) {
        if (loopErr instanceof ModelPolicyDispatchBlockedError) {
          const denyReasonsSummary = loopErr.reasons.length === 0
            ? "no candidate models"
            : loopErr.reasons
                .map((r) => `${r.provider}/${r.modelId} (${r.reason})`)
                .join("; ");
          dispatchSettled = settleDispatchPolicyBlocked(
            dispatchId,
            denyReasonsSummary,
            {
              markPolicyBlocked: activeMarkPolicyBlocked,
              logWriteFailure: logDispatchLedgerWriteFailure,
            },
          ) || dispatchSettled;
          if (dispatchSettled) {
            logWarning(
              "dispatch",
              `dispatch settled as policy-blocked (denyReasons=${denyReasonsSummary})`,
              { dispatchId: String(dispatchId), unitType: loopErr.unitType, unitId: loopErr.unitId },
            );
          }
        } else {
          dispatchSettled = settleDispatchFailed(
            dispatchId,
            formatUnhandledDispatchErrorSummary({ error: loopErr }),
            {
              markFailed: activeMarkDispatchFailed,
              logWriteFailure: logDispatchLedgerWriteFailure,
            },
          ) || dispatchSettled;
        }
      }

      // Always emit iteration-end on error so the journal records iteration
      // completion even on failure (#2344). Without this, errors in
      // runFinalize leave the journal incomplete, making diagnosis harder.
      journalReporter.emit("iteration-end", { iteration, error: msg });

      // ── Pre-send model-policy block: not a retryable error (#4959 / #4850) ──
      // The model-policy gate runs before the prompt is sent.  When every
      // candidate model is denied (cross-provider disabled + flat-rate
      // baseline + tool-policy denial), retrying the same unit produces the
      // same denial — burning the consecutive-error budget toward a 3-strike
      // hard stop and corrupting auto-mode state.  Pause for user attention
      // instead, with the per-model deny reasons surfaced from the typed
      // error.
      if (loopErr instanceof ModelPolicyDispatchBlockedError) {
        const policyDecision = decideModelPolicyBlocked({
          unitType: loopErr.unitType,
          unitId: loopErr.unitId,
          errorMessage: msg,
          reasons: loopErr.reasons,
        });
        debugLog("autoLoop", {
          phase: "model-policy-blocked",
          iteration,
          unitType: loopErr.unitType,
          unitId: loopErr.unitId,
          reasons: loopErr.reasons,
        });
        ctx.ui.notify(policyDecision.notifyMessage, "error");
        journalReporter.emit("unit-end", policyDecision.journalData);
        // Carry the blocked unit identity into the turn-result observer:
        // the throw originated inside dispatch, so observedUnitType/Id were
        // not assigned by the success path at lines 453/631/647 — but the
        // typed error already names the unit (#4959 / CodeRabbit).
        observedUnitType = loopErr.unitType;
        observedUnitId = loopErr.unitId;
        await deps.pauseAuto(ctx, pi);
        finishTurn(policyDecision.turnStatus, policyDecision.failureClass, msg);
        // Do NOT increment consecutiveErrors — the failure is configuration,
        // not a transient runtime fault.
        break;
      }

      // ── Infrastructure errors: immediate stop, no retry ──
      // These are unrecoverable (disk full, OOM, etc.). Retrying just burns
      // LLM budget on guaranteed failures.
      const infraCode = isInfrastructureError(loopErr);
      if (infraCode) {
        const infraDecision = decideInfrastructureError({
          code: infraCode,
          errorMessage: msg,
        });
        debugLog("autoLoop", {
          phase: "infrastructure-error",
          iteration,
          code: infraCode,
          error: msg,
        });
        ctx.ui.notify(infraDecision.notifyMessage, "error");
        await deps.stopAuto(ctx, pi, infraDecision.stopMessage);
        finishTurn(infraDecision.turnStatus, infraDecision.failureClass, msg);
        break;
      }

      // ── Credential cooldown: wait and retry with bounded budget ──
      // A 429 triggers a 30s credential backoff in AuthStorage. If the SDK's
      // getApiKey() retries couldn't outlast the window, the error surfaces
      // here. Wait for the cooldown to clear rather than counting it as a
      // consecutive failure — but cap retries so we don't spin for hours
      // on persistent quota exhaustion.
      if (isTransientCooldownError(loopErr)) {
        consecutiveCooldowns++;
        const retryAfterMs = getCooldownRetryAfterMs(loopErr);
        const cooldownDecision = decideCooldownRecovery({
          consecutiveCooldowns,
          maxCooldownRetries: MAX_COOLDOWN_RETRIES,
          retryAfterMs,
          fallbackWaitMs: COOLDOWN_FALLBACK_WAIT_MS,
        });
        debugLog("autoLoop", {
          phase: "cooldown-wait",
          iteration,
          consecutiveCooldowns,
          retryAfterMs,
          error: msg,
        });

        if (cooldownDecision.action === "stop") {
          ctx.ui.notify(cooldownDecision.notifyMessage, "error");
          finishTurn("stopped", "timeout", msg);
          await deps.stopAuto(ctx, pi, cooldownDecision.stopMessage);
          break;
        }

        ctx.ui.notify(cooldownDecision.notifyMessage, "warning");
        await new Promise(resolve => setTimeout(resolve, cooldownDecision.waitMs));
        finishTurn("retry", "timeout", msg);
        continue; // Retry iteration without incrementing consecutiveErrors
      }

      consecutiveErrors++;
      recentErrorMessages.push(msg.length > 120 ? msg.slice(0, 120) + "..." : msg);
      debugLog("autoLoop", {
        phase: "iteration-error",
        iteration,
        consecutiveErrors,
        error: msg,
      });

      const errorDecision = decideIterationErrorRecovery({
        consecutiveErrors,
        recentErrorMessages,
        currentErrorMessage: msg,
      });
      if (errorDecision.action === "stop") {
        ctx.ui.notify(errorDecision.notifyMessage, "error");
        await deps.stopAuto(ctx, pi, errorDecision.stopMessage);
        finishTurn(errorDecision.turnStatus, "execution", msg);
        break;
      }
      if (errorDecision.action === "invalidate-and-retry") {
        ctx.ui.notify(errorDecision.notifyMessage, "warning");
        deps.invalidateAllCaches();
      } else {
        ctx.ui.notify(errorDecision.notifyMessage, "warning");
      }
      finishTurn(errorDecision.turnStatus, "execution", msg);
    }
  }

  _clearCurrentResolve();
  debugLog("autoLoop", { phase: "exit", totalIterations: iteration });
}

export async function runUokKernelLoop(
  ctx: ExtensionContext,
  pi: ExtensionAPI,
  s: AutoSession,
  deps: LoopDeps,
): Promise<void> {
  return autoLoop(ctx, pi, s, deps, { dispatchContract: "uok-scheduler" });
}

export async function runLegacyAutoLoop(
  ctx: ExtensionContext,
  pi: ExtensionAPI,
  s: AutoSession,
  deps: LoopDeps,
): Promise<void> {
  return autoLoop(ctx, pi, s, deps, { dispatchContract: "legacy-direct" });
}
