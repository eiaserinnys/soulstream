import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import { createDetachedClaudeEventBridge } from
  "../../src/runtime/detached_claude_event_bridge.js";

describe("createDetachedClaudeEventBridge", () => {
  it("preserves the existing map, publish, then followup ordering", async () => {
    const task = { agentSessionId: "session-a" } as never;
    const order: string[] = [];
    const publishEngineEvent = vi.fn(async () => { order.push("publish"); });
    const collectDetached = vi.fn(async () => { order.push("collect"); });
    const bridge = createDetachedClaudeEventBridge({
      logger: pino({ level: "silent" }),
      findTask: () => task,
      getPublisher: () => ({ publishEngineEvent }),
      collectDetached,
    });

    const continueAfterResponse = await bridge(
      "session-a",
      { type: "text", text: "hello", timestamp: 1 },
    );

    expect(publishEngineEvent).toHaveBeenCalledWith(task, {
      type: "assistant_message",
      content: "hello",
      timestamp: 1,
    });
    expect(collectDetached).not.toHaveBeenCalled();
    expect(order).toEqual(["publish"]);

    await continueAfterResponse();

    expect(collectDetached).toHaveBeenCalledWith(task, {
      type: "assistant_message",
      content: "hello",
      timestamp: 1,
    });
    expect(order).toEqual(["publish", "collect"]);
  });

  it("derives per-payload semantic keys from the runner correlation", async () => {
    const task = { agentSessionId: "session-a" } as never;
    const publishEngineEvent = vi.fn(async () => undefined);
    const bridge = createDetachedClaudeEventBridge({
      logger: pino({ level: "silent" }),
      findTask: () => task,
      getPublisher: () => ({ publishEngineEvent }),
      collectDetached: async () => undefined,
    });

    await bridge(
      "session-a",
      { type: "text", text: "hello", timestamp: 1 },
      "runner:detached:1",
    );

    expect(publishEngineEvent).toHaveBeenCalledWith(task, {
      type: "assistant_message",
      content: "hello",
      timestamp: 1,
      _dedupe_key: "runner:detached:1:0",
    });
  });

  it("preserves the SDK assistant identity for post-publish native consumption", async () => {
    const task = { agentSessionId: "session-a" } as never;
    const collected: Record<string, unknown>[] = [];
    const bridge = createDetachedClaudeEventBridge({
      logger: pino({ level: "silent" }), findTask: () => task,
      getPublisher: () => ({
        publishEngineEvent: async (_task, payload) => {
          delete (payload as Record<string, unknown>)._dedupe_key;
        },
      }),
      collectDetached: async (_task, payload) => {
        collected.push(payload as unknown as Record<string, unknown>);
      },
    });
    const afterResponse = await bridge(
      "session-a",
      {
        type: "text", text: "native done",
        sdkDedupeKey: "claude-sdk:assistant:assistant-native:0",
      } as never,
      "runner-correlation",
    );

    await afterResponse();

    expect(collected[0]?._dedupe_key).toBe("claude-sdk:assistant:assistant-native:0");
  });
});
