// Project/App: GSD-2
// File Purpose: Custom-engine verification retry adapter for auto-mode loop.

import type { AutoSession } from "./session.js";
import {
  decideCustomEngineRecovery,
  decideCustomEngineVerifyRetry,
} from "./workflow-kernel.js";
import {
  buildRetryCounterKey,
  readRetryCounter,
  type RetryCounterMigrationEvent,
} from "./retry-counter-key.js";

type RetrySession = Pick<AutoSession, "verificationRetryCount">;

export type CustomEngineRecoverResult = {
  outcome: "retry" | "skip" | "stop" | "pause";
  reason?: string;
};

export type CustomEngineVerifyRetryOutcome =
  | { action: "retry"; attempts: number }
  | { action: "pause"; attempts: number; turnError: string }
  | { action: "stop"; attempts: number; stopMessage: string; turnError: string };

export interface HandleCustomEngineVerifyRetryDeps {
  hydrateRetryCounts: () => Map<string, number>;
  saveRetryCounts: () => void;
  recover: (
    unitType: string,
    unitId: string,
    options: { basePath: string },
  ) => Promise<CustomEngineRecoverResult>;
  logRetry: (details: { iteration: number; unitId: string; attempts: number }) => void;
  reportRetry: (details: { unitType: string; unitId: string; attempts: number }) => void;
  /** Optional sink for legacy-key migration events; defaults to no-op for tests. */
  onLegacyMigrated?: (event: RetryCounterMigrationEvent) => void;
}

export async function handleCustomEngineVerifyRetry(input: {
  session: RetrySession;
  unitType: string;
  unitId: string;
  basePath: string;
  iteration: number;
  maxRetries: number;
  deps: HandleCustomEngineVerifyRetryDeps;
}): Promise<CustomEngineVerifyRetryOutcome> {
  const retryCounts = input.deps.hydrateRetryCounts();
  // Read accepts canonical `verify:${id}`, legacy `${type}/${id}`, and the
  // pre-T05 bare-id schema. On legacy hit the value is migrated forward so
  // the in-memory map and the persisted JSON converge.
  const attempts = readRetryCounter(
    retryCounts,
    "verify",
    input.unitId,
    input.deps.onLegacyMigrated,
  ) + 1;
  input.session.verificationRetryCount.set(
    buildRetryCounterKey("verify", input.unitId),
    attempts,
  );
  input.deps.saveRetryCounts();
  input.deps.logRetry({
    iteration: input.iteration,
    unitId: input.unitId,
    attempts,
  });
  input.deps.reportRetry({
    unitType: input.unitType,
    unitId: input.unitId,
    attempts,
  });

  const retryDecision = decideCustomEngineVerifyRetry({
    attempts,
    maxRetries: input.maxRetries,
  });
  if (retryDecision.action === "retry") {
    return { action: "retry", attempts };
  }

  const recovery = await input.deps.recover(input.unitType, input.unitId, {
    basePath: input.basePath,
  });
  const recoveryDecision = decideCustomEngineRecovery({
    outcome: recovery.outcome,
    reason: recovery.reason,
    unitId: input.unitId,
    attempts,
  });
  if (recoveryDecision.action === "pause") {
    return {
      action: "pause",
      attempts,
      turnError: recoveryDecision.turnError,
    };
  }

  return {
    action: "stop",
    attempts,
    stopMessage: recoveryDecision.stopMessage,
    turnError: recoveryDecision.turnError,
  };
}
