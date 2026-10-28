import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

import type { ClaudeAccountRateLimitSwitchRequest } from "./claude_adapter.js";
import type { ClaudeClientEvent } from "./claude_client_event.js";
import * as rateLimit from "./claude_sdk_rate_limit_stop_failure.js";
import type { ClaudeRuntimeCloseReason } from "./claude_session_runtime.js";
import type { ClaudeSessionRuntime } from "./claude_session_runtime.js";
import {
  type ActiveForeground,
  settleInterventionInterrupt,
} from "./claude_sdk_persistent_session_support.js";

export interface ClaudeSdkPersistentRateLimitSwitchContext {
  active: ActiveForeground;
  event: ClaudeClientEvent;
  accountSwitchEnabled: boolean;
  bypassSwitchGate: boolean;
  runtime: ClaudeSessionRuntime<SDKUserMessage>;
  setAccountSwitch(request: ClaudeAccountRateLimitSwitchRequest): void;
  close(reason: ClaudeRuntimeCloseReason): Promise<void>;
}

export interface ClaudeSdkPersistentRateLimitTerminationContext {
  active: ActiveForeground;
  event: ClaudeClientEvent;
  runtime: ClaudeSessionRuntime<SDKUserMessage>;
  clearForegroundTimers(active: ActiveForeground | null): void;
  finishDrainTimer(): void;
  isActiveForeground(active: ActiveForeground): boolean;
  clearActiveForeground(): void;
}

export async function observeClaudeSdkPersistentAccountSwitch(
  context: ClaudeSdkPersistentRateLimitSwitchContext,
): Promise<boolean> {
  if (!context.accountSwitchEnabled || context.bypassSwitchGate) return false;
  const { active, event, runtime } = context;
  const observation = active.rateLimitSwitchGate.observe(event);
  if (observation.kind === "pending") return true;
  if (observation.kind !== "switch") return false;

  const snapshot = runtime.snapshot();
  context.setAccountSwitch({
    info: observation.info,
    ...(snapshot.sessionId ? { sessionId: snapshot.sessionId } : {}),
    inputUuid: active.uuid,
    inputDelivery: runtime.inputDelivery(active.uuid),
  });
  await context.close("account_switch");
  return true;
}

export function handleClaudeSdkPersistentRateLimitTermination(
  context: ClaudeSdkPersistentRateLimitTerminationContext,
): boolean {
  const { active, event, runtime } = context;
  active.rateLimitTerminationState = rateLimit.observeTerminationSignal(
    active.rateLimitTerminationState,
    event,
  );
  active.rateLimitTerminationInfo = rateLimit.captureRejectedRateLimitInfo(
    active.rateLimitTerminationInfo,
    event,
  );
  if (active.rateLimitTerminationState !== "terminal") return false;

  active.output.push(event);
  runtime.observeResult({ userMessageUuid: active.uuid, interrupted: false });
  runtime.settleMergedInputs();
  context.clearForegroundTimers(active);
  runtime.finishForegroundResult();
  context.finishDrainTimer();
  active.output.push(rateLimit.makeStopFailureError(active.rateLimitTerminationInfo));
  active.output.close();
  if (context.isActiveForeground(active)) context.clearActiveForeground();
  settleInterventionInterrupt(active, false);
  return true;
}
