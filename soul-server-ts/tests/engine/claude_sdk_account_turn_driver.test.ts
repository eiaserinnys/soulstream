import { describe, expect, it, vi } from "vitest";

import type {
  ClaudeAccountTurnSwitchRequest,
  ClaudeRunOptions,
} from "../../src/engine/claude_adapter.js";
import type { ClaudeClientEvent } from "../../src/engine/claude_client_event.js";
import { ClaudeSdkAccountTurnDriver } from "../../src/engine/claude_sdk_account_turn_driver.js";
import { observeClaudeSdkPersistentAuthenticationFailureSwitch } from "../../src/engine/claude_sdk_persistent_rate_limit_event.js";
import type { ClaudeSdkUsageCarry } from "../../src/engine/claude_sdk_usage_carry.js";

const AUTH_FAILURE_EVENT: ClaudeClientEvent = {
  type: "assistant_error",
  errorType: "authentication_failed",
};

function baseOptions(): ClaudeRunOptions {
  return { prompt: "hello", workspaceDir: "/tmp/claude-work" };
}

async function collect(
  iterable: AsyncIterable<ClaudeClientEvent>,
): Promise<ClaudeClientEvent[]> {
  const events: ClaudeClientEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

describe("ClaudeSdkAccountTurnDriver authentication failure switch", () => {
  it("retries the turn with the next account instead of surfacing the failure", async () => {
    const driver = new ClaudeSdkAccountTurnDriver();
    const attempts: ClaudeRunOptions[] = [];
    const attempt = async function* (
      options: ClaudeRunOptions,
      _signal: AbortSignal,
      _usageCarry?: ClaudeSdkUsageCarry,
    ): AsyncGenerator<ClaudeClientEvent, ClaudeAccountTurnSwitchRequest | null, void> {
      attempts.push(options);
      if (attempts.length === 1) {
        yield { type: "text", text: "before" };
        return {
          kind: "authentication_failed" as const,
          request: {
            events: [AUTH_FAILURE_EVENT],
            sessionId: "sdk-session",
            inputUuid: "turn-uuid",
            inputDelivery: "delivered" as const,
          },
        };
      }
      yield { type: "text", text: "after" };
      return null;
    };
    const onAccountAuthenticationFailure = vi.fn(async () => ({
      kind: "switch" as const,
      options: { prompt: "continue" },
    }));
    const options: ClaudeRunOptions = {
      ...baseOptions(),
      onAccountAuthenticationFailure,
    };

    const events = await collect(driver.run(
      options,
      new AbortController().signal,
      attempt as never,
      () => false,
    ));

    expect(attempts).toHaveLength(2);
    expect(attempts[1]?.prompt).toBe("continue");
    expect(onAccountAuthenticationFailure).toHaveBeenCalledOnce();
    expect(events.map((event) => event.type)).toEqual(["text", "text"]);
  });

  it("ends the turn with the authentication failure when no candidate remains", async () => {
    const driver = new ClaudeSdkAccountTurnDriver();
    const attempts: ClaudeRunOptions[] = [];
    const attempt = async function* (
      options: ClaudeRunOptions,
    ): AsyncGenerator<ClaudeClientEvent, ClaudeAccountTurnSwitchRequest | null, void> {
      attempts.push(options);
      yield { type: "text", text: "before" };
      return {
        kind: "authentication_failed" as const,
        request: {
          events: [AUTH_FAILURE_EVENT],
          inputUuid: "turn-uuid",
          inputDelivery: "ambiguous" as const,
        },
      };
    };
    const options: ClaudeRunOptions = {
      ...baseOptions(),
      onAccountAuthenticationFailure: vi.fn(async () => ({ kind: "continue" as const })),
    };

    const events = await collect(driver.run(
      options,
      new AbortController().signal,
      attempt as never,
      () => false,
    ));

    expect(attempts).toHaveLength(1);
    expect(events.map((event) => event.type)).toEqual(["text", "assistant_error"]);
  });

  it("does not switch when the options have no authentication-failure hook", async () => {
    const driver = new ClaudeSdkAccountTurnDriver();
    let attempts = 0;
    const attempt = async function* (): AsyncGenerator<
      ClaudeClientEvent,
      ClaudeAccountTurnSwitchRequest | null,
      void
    > {
      attempts += 1;
      return {
        kind: "authentication_failed" as const,
        request: {
          events: [AUTH_FAILURE_EVENT],
          inputUuid: "turn-uuid",
          inputDelivery: "delivered" as const,
        },
      };
    };

    const events = await collect(driver.run(
      baseOptions(),
      new AbortController().signal,
      attempt as never,
      () => false,
    ));

    expect(attempts).toBe(1);
    expect(events).toEqual([]);
  });
});

describe("observeClaudeSdkPersistentAuthenticationFailureSwitch", () => {
  const context = () => {
    const setAccountAuthFailureSwitch = vi.fn();
    const close = vi.fn(async () => undefined);
    return {
      active: { uuid: "turn-uuid" } as Parameters<
        typeof observeClaudeSdkPersistentAuthenticationFailureSwitch
      >[0]["active"],
      event: AUTH_FAILURE_EVENT,
      authFailureSwitchEnabled: true,
      bypassSwitchGate: false,
      runtime: {
        snapshot: () => ({ sessionId: "sdk-session" }),
        inputDelivery: () => "delivered" as const,
      } as unknown as Parameters<
        typeof observeClaudeSdkPersistentAuthenticationFailureSwitch
      >[0]["runtime"],
      setAccountAuthFailureSwitch,
      close,
    };
  };

  it("captures the failure event and closes the query for an account switch", async () => {
    const ctx = context();
    const observed = await observeClaudeSdkPersistentAuthenticationFailureSwitch(ctx);

    expect(observed).toBe(true);
    expect(ctx.setAccountAuthFailureSwitch).toHaveBeenCalledWith({
      events: [AUTH_FAILURE_EVENT],
      sessionId: "sdk-session",
      inputUuid: "turn-uuid",
      inputDelivery: "delivered",
    });
    expect(ctx.close).toHaveBeenCalledWith("account_switch");
  });

  it("lets other events and disabled switching pass through", async () => {
    const ctx = context();
    expect(await observeClaudeSdkPersistentAuthenticationFailureSwitch({
      ...ctx,
      event: { type: "text", text: "hello" },
    })).toBe(false);

    const disabled = context();
    expect(await observeClaudeSdkPersistentAuthenticationFailureSwitch({
      ...disabled,
      authFailureSwitchEnabled: false,
    })).toBe(false);
    expect(disabled.close).not.toHaveBeenCalled();
  });
});
