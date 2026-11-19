import type {
  ClaudeAccountTurnSwitchRequest,
  ClaudeRunOptions,
} from "./claude_adapter.js";
import type { ClaudeClientEvent } from "./claude_client_event.js";
import type { ClaudeSdkPersistentSession } from "./claude_sdk_persistent_session.js";
import { makeStopFailureError } from "./claude_sdk_rate_limit_stop_failure.js";
import { ClaudeSdkUsageCarry } from "./claude_sdk_usage_carry.js";

export type ClaudeSdkAccountTurnAttempt = (
  options: ClaudeRunOptions,
  signal: AbortSignal,
  usageCarry?: ClaudeSdkUsageCarry,
) => AsyncGenerator<ClaudeClientEvent, ClaudeAccountTurnSwitchRequest | null, void>;

export class ClaudeSdkAccountTurnDriver {
  async *runPersistentAttempt(
    options: ClaudeRunOptions,
    signal: AbortSignal,
    usageCarry: ClaudeSdkUsageCarry | undefined,
    runTurn: (
      options: ClaudeRunOptions,
      signal: AbortSignal,
      usageCarry: ClaudeSdkUsageCarry | undefined,
      onSession: (session: ClaudeSdkPersistentSession) => void,
    ) => AsyncIterable<ClaudeClientEvent>,
    settle: () => Promise<void>,
  ): AsyncGenerator<ClaudeClientEvent, ClaudeAccountTurnSwitchRequest | null, void> {
    const sessionRef: { current: ClaudeSdkPersistentSession | null } = { current: null };
    try {
      for await (const event of runTurn(
        options,
        signal,
        usageCarry,
        (session) => { sessionRef.current = session; },
      )) {
        yield event;
      }
    } finally {
      if (
        options.trackChildExit
        && (!sessionRef.current || sessionRef.current.snapshot().queryLifecycle !== "open")
      ) {
        await sessionRef.current?.settled();
        await settle();
      }
    }
    return sessionRef.current?.takeAccountSwitch() ?? null;
  }

  async *run(
    options: ClaudeRunOptions,
    signal: AbortSignal,
    attempt: ClaudeSdkAccountTurnAttempt,
    shouldStop: () => boolean,
  ): AsyncIterable<ClaudeClientEvent> {
    const switchEnabled = options.onAccountRateLimit !== undefined
      || options.onAccountAuthenticationFailure !== undefined;
    const usageCarry = switchEnabled ? new ClaudeSdkUsageCarry() : undefined;
    if (!switchEnabled) {
      yield* attempt(options, signal, undefined);
      return;
    }
    let attemptOptions = options;
    try {
      for (;;) {
        if (signal.aborted || shouldStop()) return;
        const switchRequest = yield* attempt(attemptOptions, signal, usageCarry);
        if (!switchRequest || signal.aborted || shouldStop()) return;

        if (switchRequest.kind === "rate_limit") {
          if (!attemptOptions.onAccountRateLimit) return;
          const decision = await attemptOptions.onAccountRateLimit(
            switchRequest.request,
            signal,
          );
          if (signal.aborted || shouldStop() || decision.kind === "cancelled") return;
          if (decision.kind === "exhausted") {
            const rateLimitInfo = { ...switchRequest.request.info };
            if (decision.resetsAt !== undefined) {
              if (decision.resetsAt === null) delete rateLimitInfo.resetsAt;
              else rateLimitInfo.resetsAt = decision.resetsAt;
            }
            yield makeStopFailureError({
              ...rateLimitInfo,
            });
            return;
          }
          attemptOptions = { ...attemptOptions, ...decision.options };
          if (
            !switchRequest.request.sessionId
            && switchRequest.request.inputDelivery === "not_sent"
          ) {
            attemptOptions.inputUuid = switchRequest.request.inputUuid;
          }
          continue;
        }

        if (!attemptOptions.onAccountAuthenticationFailure) return;
        const decision = await attemptOptions.onAccountAuthenticationFailure(
          switchRequest.request,
          signal,
        );
        if (signal.aborted || shouldStop() || decision.kind === "cancelled") return;
        if (decision.kind === "continue") {
          // 후보가 없다. 인증 실패 이벤트를 그대로 내보내고 오늘처럼 턴을 끝낸다.
          for (const event of switchRequest.request.events) yield event;
          return;
        }
        attemptOptions = { ...attemptOptions, ...decision.options };
        if (
          !switchRequest.request.sessionId
          && switchRequest.request.inputDelivery === "not_sent"
        ) {
          attemptOptions.inputUuid = switchRequest.request.inputUuid;
        }
      }
    } finally {
      usageCarry?.clear();
    }
  }
}
