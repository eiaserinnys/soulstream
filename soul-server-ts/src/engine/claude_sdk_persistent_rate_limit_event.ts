import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

import type {
  ClaudeAccountAuthenticationFailureSwitchRequest,
  ClaudeAccountRateLimitSwitchRequest,
  ClaudeAccountTurnSwitchRequest,
} from "./claude_adapter.js";
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

export interface ClaudeSdkPersistentAuthFailureSwitchContext {
  active: ActiveForeground;
  event: ClaudeClientEvent;
  authFailureSwitchEnabled: boolean;
  bypassSwitchGate: boolean;
  runtime: ClaudeSessionRuntime<SDKUserMessage>;
  setAccountAuthFailureSwitch(request: ClaudeAccountAuthenticationFailureSwitchRequest): void;
  close(reason: ClaudeRuntimeCloseReason): Promise<void>;
}

/** 세션이 붙잡아 둔 계정 전환 요청들. 드라이버가 시도가 끝난 뒤 꺼낸다. */
export class ClaudeSdkPersistentAccountSwitchStore {
  private rateLimitSwitch: ClaudeAccountRateLimitSwitchRequest | null = null;
  private authFailureSwitch: ClaudeAccountAuthenticationFailureSwitchRequest | null = null;

  hasPending(): boolean {
    return this.rateLimitSwitch !== null || this.authFailureSwitch !== null;
  }

  setRateLimitSwitch(request: ClaudeAccountRateLimitSwitchRequest): void {
    this.rateLimitSwitch = request;
  }

  setAuthFailureSwitch(request: ClaudeAccountAuthenticationFailureSwitchRequest): void {
    this.authFailureSwitch = request;
  }

  take(): ClaudeAccountTurnSwitchRequest | null {
    const rateLimitSwitch = this.rateLimitSwitch;
    const authFailureSwitch = this.authFailureSwitch;
    this.rateLimitSwitch = null;
    this.authFailureSwitch = null;
    if (rateLimitSwitch) return { kind: "rate_limit", request: rateLimitSwitch };
    return authFailureSwitch
      ? { kind: "authentication_failed", request: authFailureSwitch }
      : null;
  }
}

export interface ClaudeSdkPersistentAccountSwitchesContext {
  active: ActiveForeground;
  event: ClaudeClientEvent;
  rateLimitSwitchEnabled: boolean;
  authFailureSwitchEnabled: boolean;
  bypassSwitchGate: boolean;
  runtime: ClaudeSessionRuntime<SDKUserMessage>;
  switches: ClaudeSdkPersistentAccountSwitchStore;
  close(reason: ClaudeRuntimeCloseReason): Promise<void>;
}

/** 한도 전환 게이트와 인증 실패 전환을 같은 자리에서 관찰한다. */
export async function observeClaudeSdkPersistentAccountSwitches(
  context: ClaudeSdkPersistentAccountSwitchesContext,
): Promise<boolean> {
  const switchedByRateLimit = await observeClaudeSdkPersistentAccountSwitch({
    active: context.active,
    event: context.event,
    accountSwitchEnabled: context.rateLimitSwitchEnabled,
    bypassSwitchGate: context.bypassSwitchGate,
    runtime: context.runtime,
    setAccountSwitch: (request) => context.switches.setRateLimitSwitch(request),
    close: context.close,
  });
  if (switchedByRateLimit) return true;
  return await observeClaudeSdkPersistentAuthenticationFailureSwitch({
    active: context.active,
    event: context.event,
    authFailureSwitchEnabled: context.authFailureSwitchEnabled,
    bypassSwitchGate: context.bypassSwitchGate,
    runtime: context.runtime,
    setAccountAuthFailureSwitch: (request) => context.switches.setAuthFailureSwitch(request),
    close: context.close,
  });
}

/**
 * 중앙 계정의 인증 실패를 한도 전환과 같은 방식으로 붙잡는다. 실패 이벤트는
 * 후보가 없을 때만 그대로 내보내고, 전환하면 버린다.
 */
export async function observeClaudeSdkPersistentAuthenticationFailureSwitch(
  context: ClaudeSdkPersistentAuthFailureSwitchContext,
): Promise<boolean> {
  if (!context.authFailureSwitchEnabled || context.bypassSwitchGate) return false;
  const { active, event, runtime } = context;
  if (event.type !== "assistant_error" || event.errorType !== "authentication_failed") {
    return false;
  }
  const snapshot = runtime.snapshot();
  context.setAccountAuthFailureSwitch({
    events: [event],
    ...(snapshot.sessionId ? { sessionId: snapshot.sessionId } : {}),
    inputUuid: active.uuid,
    inputDelivery: runtime.inputDelivery(active.uuid),
  });
  await context.close("account_switch");
  return true;
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
