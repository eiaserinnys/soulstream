import { describe, expect, it } from "vitest";

import type { ClaudeClientEvent } from "../../src/engine/claude_client_event.js";
import { ClaudeSdkRateLimitSwitchGate } from
  "../../src/engine/claude_sdk_rate_limit_switch_gate.js";

const rejected: ClaudeClientEvent = {
  type: "rate_limit",
  status: "rejected",
  rateLimitType: "five_hour",
  resetsAt: "2026-10-28T12:00:00.000Z",
};
const stopFailure: ClaudeClientEvent = {
  type: "claude_runtime_hook_event",
  hookEventName: "StopFailure",
  hookInput: { error: "rate_limit" },
};

describe("Claude SDK account switch signal gate", () => {
  it.each([
    ["rate limit first", [rejected, stopFailure]],
    ["StopFailure first", [stopFailure, rejected]],
  ])("buffers a complete signal pair regardless of order (%s)", (_label, events) => {
    const gate = new ClaudeSdkRateLimitSwitchGate();
    expect(gate.observe(events[0]!)).toEqual({ kind: "pending" });
    expect(gate.observe(events[1]!)).toEqual({
      kind: "switch",
      info: {
        rateLimitType: "five_hour",
        resetsAt: "2026-10-28T12:00:00.000Z",
      },
    });
    expect(gate.discard()).toEqual(events);
  });

  it("keeps warnings and one signal nonterminal and can flush the held events", () => {
    const gate = new ClaudeSdkRateLimitSwitchGate();
    expect(gate.observe({
      type: "rate_limit",
      status: "allowed_warning",
      utilization: 0.91,
    })).toMatchObject({ kind: "pass" });
    expect(gate.observe(rejected)).toEqual({ kind: "pending" });
    expect(gate.observe({ type: "text", text: "limit details" })).toEqual({ kind: "pending" });
    expect(gate.hasPendingSignal()).toBe(true);
    expect(gate.flush()).toEqual([rejected, { type: "text", text: "limit details" }]);
    expect(gate.hasPendingSignal()).toBe(false);
  });

  it("does not pair a rejected limit with an unrelated StopFailure", () => {
    const gate = new ClaudeSdkRateLimitSwitchGate();
    expect(gate.observe(rejected)).toEqual({ kind: "pending" });
    expect(gate.observe({
      type: "claude_runtime_hook_event",
      hookEventName: "StopFailure",
      hookInput: { error: "tool_error" },
    })).toEqual({ kind: "pending" });
    expect(gate.flush()).toHaveLength(2);
  });
});
