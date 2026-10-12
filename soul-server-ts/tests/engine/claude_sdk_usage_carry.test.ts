import { describe, expect, it } from "vitest";

import type { ClaudeClientEvent } from "../../src/engine/claude_client_event.js";
import { ClaudeSdkUsageCarry } from "../../src/engine/claude_sdk_usage_carry.js";
import { attachClaudeResultReceiptMetadata, readClaudeResultReceiptMetadata } from
  "../../src/engine/claude_result_receipt_metadata.js";

// Use the same client-event surface as the existing persistent-session harness.
function result(usage: unknown, turnCostUsd: number): ClaudeClientEvent {
  return { type: "result", success: true, output: "done", usage, turnCostUsd };
}

describe("Claude withheld Result usage carry", () => {
  it("filters expected interrupt terminals into the carry and applies it on the next emitted Result", () => {
    const carry = new ClaudeSdkUsageCarry();
    const interrupted: ClaudeClientEvent = {
      ...result({ input_tokens: 10, output_tokens: 2 }, 0.000001), success: false,
    };
    const context: ClaudeClientEvent = {
      type: "context_usage", usedTokens: 12, maxTokens: 100, percent: 12,
    };
    const diagnostic: ClaudeClientEvent = {
      type: "error", message: "interrupted", fatal: false, errorCode: "error_during_execution",
    };
    const otherError: ClaudeClientEvent = { type: "error", message: "other diagnostic", fatal: true };

    expect(carry.emittable([interrupted, context, diagnostic, otherError], true))
      .toEqual([context, otherError]);
    const events: ClaudeClientEvent[] = [
      result({ input_tokens: 20, output_tokens: 3 }, 0.000002), context,
      { type: "complete", usage: { input_tokens: 20, output_tokens: 3 }, turnCostUsd: 0.000002 },
    ];
    const emitted = carry.emittable(events, false);
    expect(emitted.map(event => event.type)).toEqual(["result", "context_usage", "complete"]);
    expect(emitted[1]).toBe(context);
    for (const event of [emitted[0], emitted[2]]) {
      expect(event).toMatchObject({
        usage: { input_tokens: 30, output_tokens: 5 }, turnCostUsd: 0.000003,
      });
    }
    expect(carry.emittable(events, false)).toBe(events);
  });

  it("sums nested counters, keeps the latest nonnumeric values, and leaves exact Results intact", () => {
    const carry = new ClaudeSdkUsageCarry();
    const first = { ...result({
      input_tokens: 10, output_tokens: 2, cache_creation_input_tokens: 7,
      cache_creation: { ephemeral_5m_input_tokens: 3, ephemeral_1h_input_tokens: 4 },
      output_tokens_details: { reasoning_tokens: 1 }, server_tool_use: { web_search_requests: 1 },
      iterations: [{ input_tokens: 10 }], service_tier: "standard",
    }, 0.000001), firstCall: { inputTokens: 17, cachedInputTokens: 0 }, model: "old-model" };
    carry.absorb([first]);
    carry.absorb([result({ input_tokens: 5, output_tokens: 1 }, 0.000002)]);
    const lastUsage = {
      input_tokens: 20, output_tokens: 3, cache_creation_input_tokens: 11,
      cache_creation: { ephemeral_5m_input_tokens: 5, ephemeral_1h_input_tokens: 6 },
      output_tokens_details: { reasoning_tokens: 2 }, server_tool_use: { web_search_requests: 2 },
      iterations: [{ input_tokens: 20 }], service_tier: "priority",
    };
    const exactResult = { ...result(lastUsage, 0.000003), model: "new-model" };
    attachClaudeResultReceiptMetadata(exactResult, { inputUuid: "last-input" });
    const context: ClaudeClientEvent = { type: "context_usage", usedTokens: 20, maxTokens: 100, percent: 20 };
    const events: ClaudeClientEvent[] = [exactResult, context, {
      type: "complete", usage: lastUsage, turnCostUsd: 0.000003, model: "new-model",
      firstCall: { inputTokens: 20, cachedInputTokens: 0 },
    }];
    const combined = carry.applyTo(events);
    for (const event of [combined[0], combined[2]]) {
      expect(event).toMatchObject({
        usage: { ...lastUsage, input_tokens: 35, output_tokens: 6, cache_creation_input_tokens: 18,
          cache_creation: { ephemeral_5m_input_tokens: 8, ephemeral_1h_input_tokens: 10 },
          output_tokens_details: { reasoning_tokens: 3 }, server_tool_use: { web_search_requests: 3 } },
        turnCostUsd: 0.000006, firstCall: first.firstCall, model: "new-model",
      });
    }
    expect(combined[1]).toBe(context);
    expect(readClaudeResultReceiptMetadata(combined[0]!)).toEqual({ inputUuid: "last-input" });
    expect(exactResult.usage).toBe(lastUsage);
    expect(exactResult.turnCostUsd).toBe(0.000003);
    expect(carry.applyTo(events)).toBe(events);
    carry.absorb([first]);
    carry.clear();
    expect(carry.applyTo(events)).toBe(events);
  });
});
