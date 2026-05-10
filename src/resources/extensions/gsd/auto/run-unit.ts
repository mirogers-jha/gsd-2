// GSD-2 + src/resources/extensions/gsd/auto/run-unit.ts - Runs one GSD auto-mode unit from session creation through agent completion.

/**
 * auto/run-unit.ts — Single unit execution: session create → prompt → await agent_end.
 *
 * Imports from: auto/types, auto/resolve
 */

import type { ExtensionAPI, ExtensionContext } from "@gsd/pi-coding-agent";

import type { AutoSession } from "./session.js";
import { NEW_SESSION_TIMEOUT_MS } from "./session.js";
import type { UnitResult } from "./types.js";
import {
  _clearCurrentResolve,
  _consumePendingSwitchCancellation,
  _setCurrentResolve,
  _setSessionSwitchInFlight,
  isSessionSwitchInFlight,
} from "./resolve.js";
import {
  getCurrentTurnGeneration,
  runWithTurnGeneration,
} from "./turn-epoch.js";
import { debugLog } from "../debug-logger.js";
import { logWarning, logError } from "../workflow-logger.js";
import { resolveAutoSupervisorConfig } from "../preferences.js";
import { formatAutoUnitWorkingMessage } from "../working-output-messages.js";

// Tracks the latest session-switch attempt so a late timeout settlement from an
// older runUnit() call cannot clear the guard for a newer one.
let sessionSwitchGeneration = 0;

// ─── Agent-end-dispatcher seam (M002/S04/T01) ───────────────────────────────
//
// Test-only injection point for the `s.cmdCtx!.newSession({...})` boundary —
// the only awaitable call between `_setSessionSwitchInFlight(true)` and the
// chained `.finally()` flag-clearer that a deterministic test can poison.
//
// Production code MUST read `activeAgentEndDispatcher` on every call (no
// `const x = activeAgentEndDispatcher` closure capture). The plan-time grep
// gate at S04-RESEARCH §"Seam install-order structural guarantee" enforces
// this; the source-guard subtest in
// `tests/auto-run-unit-flag-cleared-on-synthetic-throw.test.ts` re-asserts
// it. Pattern mirrors `parallel-sqlite-cli.ts:_setSqliteRunnerForTests` and
// `gsd-db.ts:_setOpenDatabaseForTests`.
//
// Why this signature: the seam wraps the new-session call shape that
// `s.cmdCtx!.newSession({...})` would otherwise dispatch directly. The
// dispatcher returns a Promise that resolves to whatever `newSession`
// resolves to (typed as `unknown` here because the new-session return type
// is opaque to this module — the only consumer is the `.finally()` chain
// and the `await Promise.race(...)` result drop).
type AgentEndDispatcherCmdCtx = {
  newSession: (opts: {
    abortSignal: AbortSignal;
    cwd: string;
  }) => Promise<{ cancelled: boolean }>;
};
type AgentEndDispatcherFn = (
  cmdCtx: AgentEndDispatcherCmdCtx,
  opts: { abortSignal: AbortSignal; cwd: string },
) => Promise<{ cancelled: boolean }>;

const defaultAgentEndDispatcher: AgentEndDispatcherFn = (cmdCtx, opts) =>
  cmdCtx.newSession(opts);

let activeAgentEndDispatcher: AgentEndDispatcherFn = defaultAgentEndDispatcher;

/**
 * Test-only seam (M002/S04/T01). Pass an impl to install it; pass `null` to
 * reset to the default. Underscore-prefixed to signal "not for production
 * use". Mirrors `_setSqliteRunnerForTests` and `_setOpenDatabaseForTests`.
 */
export function _setAgentEndDispatcherForTests(
  impl: AgentEndDispatcherFn | null,
): void {
  activeAgentEndDispatcher = impl ?? defaultAgentEndDispatcher;
}

/**
 * Reset the seam to the default impl. Always call from `afterEach` so
 * subsequent tests are not contaminated.
 */
export function _resetAgentEndDispatcherForTests(): void {
  activeAgentEndDispatcher = defaultAgentEndDispatcher;
}

/**
 * Execute a single unit: create a new session, send the prompt, and await
 * the agent_end promise. Returns a UnitResult describing what happened.
 *
 * The promise is one-shot: resolveAgentEnd() is the only way to resolve it.
 * On session creation failure or timeout, returns { status: 'cancelled' }
 * without awaiting the promise.
 */
export async function runUnit(
  ctx: ExtensionContext,
  pi: ExtensionAPI,
  s: AutoSession,
  unitType: string,
  unitId: string,
  prompt: string,
): Promise<UnitResult> {
  debugLog("runUnit", { phase: "start", unitType, unitId });

  // Ensure cwd matches basePath BEFORE newSession() captures it. The new
  // session reads process.cwd() during construction to anchor its tool
  // runtime and system prompt; if cwd has drifted (async_bash, background
  // jobs, prior unit cleanup), the session would otherwise be rooted to
  // the wrong directory. Must be synchronous — no awaits between chdir
  // and newSession (#1389, #4762 follow-up).
  try {
    if (process.cwd() !== s.basePath) {
      process.chdir(s.basePath);
    }
  } catch (e) {
    const msg = `Failed to chdir to basePath before newSession (basePath: ${s.basePath}): ${String(e)}`;
    logWarning("engine", msg, { basePath: s.basePath, error: String(e) });
    return {
      status: "cancelled",
      errorContext: {
        message: msg,
        category: "session-failed",
        isTransient: true,
      },
    };
  }

  // ── Session creation with timeout ──
  debugLog("runUnit", { phase: "session-create", unitType, unitId });

  let sessionResult: { cancelled: boolean };
  let sessionTimeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const mySessionSwitchGeneration = ++sessionSwitchGeneration;
  // #3731: Cancellation controller for newSession(). When the session-creation
  // timeout fires, we abort this controller so that the still-in-flight
  // newSession() discards itself after await this.abort() completes, preventing
  // it from capturing the (now-root) process.cwd() and rebuilding the tool
  // runtime with the wrong cwd.
  const sessionAbortController = new AbortController();
  // _setAgentEndDispatcherForTests envelope (M002/S04/T01 — D011 hardening per
  // RESEARCH §T01). Pre-fix `_setSessionSwitchInFlight(true)` lived OUTSIDE the
  // try block (between `++sessionSwitchGeneration` and `try {`). Neither `let`
  // declarations nor numeric `++` can throw synchronously in current Node so
  // the bug is theoretical-only — but the seam allows tests to inject a
  // synchronous throw at the dispatcher boundary, exercising the same recovery
  // path. The outer `let switchFlagThrew` + finally branch clears the flag
  // when `activeAgentEndDispatcher(...)` throws BEFORE constructing the
  // sessionPromise (its chained `.finally()` would otherwise be the only
  // clearer). Pattern mirrors M002/S04/T05 (auto/phases.ts) try/finally
  // envelope.
  let switchFlagThrew = true;
  try {
    _setSessionSwitchInFlight(true);
    try {
      const sessionPromise = activeAgentEndDispatcher(s.cmdCtx!, {
        abortSignal: sessionAbortController.signal,
        cwd: s.basePath,
      }).finally(() => {
        if (sessionSwitchGeneration === mySessionSwitchGeneration) {
          _setSessionSwitchInFlight(false);
        }
      });
      const timeoutPromise = new Promise<{ cancelled: true }>((resolve) => {
        sessionTimeoutHandle = setTimeout(
          () => {
            sessionAbortController.abort();
            resolve({ cancelled: true });
          },
          NEW_SESSION_TIMEOUT_MS,
        );
      });
      sessionResult = await Promise.race([sessionPromise, timeoutPromise]);
    } catch (sessionErr) {
      if (sessionTimeoutHandle) clearTimeout(sessionTimeoutHandle);
      _consumePendingSwitchCancellation();
      const msg =
        sessionErr instanceof Error ? sessionErr.message : String(sessionErr);
      debugLog("runUnit", {
        phase: "session-error",
        unitType,
        unitId,
        error: msg,
      });
      // NOTE: do NOT set switchFlagThrew = false here. If the dispatcher
      // threw synchronously the sessionPromise was never constructed and
      // the chained `.finally()` did not clear the flag. The outer finally
      // branch's `isSessionSwitchInFlight()` guard will detect that case
      // and clear the flag with a recovery-branch warning. If sessionPromise
      // WAS constructed and rejected, its chained `.finally()` already
      // cleared the flag so the outer guard skips silently.
      return { status: "cancelled", errorContext: { message: `Session creation failed: ${msg}`, category: "session-failed", isTransient: true } };
    }
    switchFlagThrew = false;
  } finally {
    if (
      switchFlagThrew &&
      sessionSwitchGeneration === mySessionSwitchGeneration &&
      isSessionSwitchInFlight()
    ) {
      logWarning(
        "safety",
        "_setAgentEndDispatcherForTests envelope: session-switch flag still true after throw — recovery branch fired",
        { unitType, unitId },
      );
      _setSessionSwitchInFlight(false);
    }
  }
  if (sessionTimeoutHandle) clearTimeout(sessionTimeoutHandle);

  if (sessionResult.cancelled) {
    _consumePendingSwitchCancellation();
    debugLog("runUnit-session-timeout", { unitType, unitId });
    return { status: "cancelled", errorContext: { message: "Session creation timed out", category: "timeout", isTransient: true } };
  }

  if (!s.active) {
    _consumePendingSwitchCancellation();
    return { status: "cancelled" };
  }

  if (s.currentUnitModel && typeof pi.setModel === "function") {
    const restored = await pi.setModel(s.currentUnitModel, { persist: false });
    if (!restored) {
      _consumePendingSwitchCancellation();
      const message =
        `Failed to restore configured model ${s.currentUnitModel.provider}/${s.currentUnitModel.id} after session creation`;
      ctx.ui.notify(
        `${message}. Cancelling unit before dispatch.`,
        "warning",
      );
      return {
        status: "cancelled",
        errorContext: {
          message,
          category: "session-failed",
          isTransient: false,
        },
      };
    }
  }

  // ── Create the agent_end promise (per-unit one-shot) ──
  // This happens after newSession completes so session-switch agent_end events
  // from the previous session cannot resolve the new unit.
  _setSessionSwitchInFlight(false);
  const unitPromise = new Promise<UnitResult>((resolve) => {
    _setCurrentResolve(resolve);
  });
  const pendingSwitchCancellation = _consumePendingSwitchCancellation();
  if (pendingSwitchCancellation) {
    _clearCurrentResolve();
    return {
      status: "cancelled",
      ...(pendingSwitchCancellation.errorContext ? { errorContext: pendingSwitchCancellation.errorContext } : {}),
    };
  }

  // ── Provider request-readiness pre-check (#4555) ──
  // Verify the provider can accept requests before dispatching. If the token
  // has expired since bootstrap, return cancelled immediately so the unit is
  // not wasted on a guaranteed 401.
  {
    const provider = s.currentUnitModel?.provider ?? ctx.model?.provider;
    const registry = (ctx as any).modelRegistry;

    if (provider && registry != null && typeof registry.isProviderRequestReady === "function") {
      let ready = false;
      try {
        ready = registry.isProviderRequestReady(provider);
      } catch {
        ready = false;
      }

      if (!ready) {
        _clearCurrentResolve();
        return {
          status: "cancelled",
          errorContext: {
            message: `Provider ${provider} is not request-ready (login/token expired)`,
            category: "provider",
            isTransient: false,
          },
        };
      }
    }
  }

  // ── Capture turn generation for stale-write detection ──
  // Any write site reached via the sendMessage → tool-call → await chain
  // below sees this generation via AsyncLocalStorage. If a timeout recovery
  // or cancellation bumps the generation while this turn is in flight, those
  // writes see themselves as stale and self-drop.
  const capturedTurnGen = getCurrentTurnGeneration();

  // ── Send the prompt ──
  debugLog("runUnit", { phase: "send-message", unitType, unitId });

  const requestDispatchedAt = Date.now();
  ctx.ui.setWorkingMessage?.(formatAutoUnitWorkingMessage(unitType, unitId));

  // ── Await agent_end with absolute timeout (H4 fix) ──
  // If supervision fails to resolve unitPromise within 30s, treat as cancelled.
  // Without this, a crashed agent that never emits agent_end hangs the loop (#3161).
  const supervisor = resolveAutoSupervisorConfig();
  const UNIT_HARD_TIMEOUT_MS = Math.max(
    30_000,
    ((supervisor.hard_timeout_minutes ?? 30) * 60 * 1000) + 30_000,
  );
  let unitTimeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let result: UnitResult;
  try {
    pi.sendMessage(
      { customType: "gsd-auto", content: prompt, display: s.verbose },
      { triggerTurn: true },
    );

    debugLog("runUnit", { phase: "awaiting-agent-end", unitType, unitId });
    const timeoutResult = new Promise<UnitResult>((resolve) => {
      unitTimeoutHandle = setTimeout(() => {
        resolve({ status: "cancelled", errorContext: { message: "Unit hard timeout — supervision may have failed", category: "timeout", isTransient: true } });
      }, UNIT_HARD_TIMEOUT_MS);
    });
    result = await runWithTurnGeneration(capturedTurnGen, () =>
      Promise.race([unitPromise, timeoutResult]),
    );
  } finally {
    if (unitTimeoutHandle) clearTimeout(unitTimeoutHandle);
    ctx.ui.setWorkingMessage?.(undefined);
  }
  debugLog("runUnit", {
    phase: "agent-end-received",
    unitType,
    unitId,
    status: result.status,
  });
  const finalResult: UnitResult = { ...result, requestDispatchedAt };

  // Discard trailing follow-up messages (e.g. async_job_result notifications)
  // from the completed unit. Without this, queued follow-ups trigger wasteful
  // LLM turns before the next session can start (#1642).
  // clearQueue() lives on AgentSession but isn't part of the typed
  // ExtensionCommandContext interface — call it via runtime check.
  try {
    const cmdCtxAny = s.cmdCtx as Record<string, unknown> | null;
    if (typeof cmdCtxAny?.clearQueue === "function") {
      (cmdCtxAny.clearQueue as () => unknown)();
    }
  } catch (e) {
    logWarning("engine", "clearQueue failed after unit completion", { error: String(e) });
  }

  return finalResult;
}
