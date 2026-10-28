import type {
  ClaudeAccountRateLimitSwitchRequest,
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
) => AsyncGenerator<ClaudeClientEvent, ClaudeAccountRateLimitSwitchRequest | null, void>;

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
  ): AsyncGenerator<ClaudeClientEvent, ClaudeAccountRateLimitSwitchRequest | null, void> {
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
    return sessionRef.current?.takeAccountRateLimitSwitch() ?? null;
  }

  async *run(
    options: ClaudeRunOptions,
    signal: AbortSignal,
    attempt: ClaudeSdkAccountTurnAttempt,
    shouldStop: () => boolean,
  ): AsyncIterable<ClaudeClientEvent> {
    const usageCarry = options.onAccountRateLimit ? new ClaudeSdkUsageCarry() : undefined;
    let attemptOptions = options;
    try {
      for (;;) {
        if (signal.aborted || shouldStop()) return;
        const switchRequest = yield* attempt(attemptOptions, signal, usageCarry);
        if (!switchRequest || !options.onAccountRateLimit || signal.aborted || shouldStop()) return;

        const decision = await options.onAccountRateLimit(switchRequest, signal);
        if (signal.aborted || shouldStop() || decision.kind === "cancelled") return;
        if (decision.kind === "exhausted") {
          yield makeStopFailureError({
            ...switchRequest.info,
            ...(decision.resetsAt ? { resetsAt: decision.resetsAt } : {}),
          });
          return;
        }
        attemptOptions = { ...attemptOptions, ...decision.options };
        if (!switchRequest.sessionId && switchRequest.inputDelivery === "not_sent") {
          attemptOptions.inputUuid = switchRequest.inputUuid;
        }
      }
    } finally {
      usageCarry?.clear();
    }
  }
}
