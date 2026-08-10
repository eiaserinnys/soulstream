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

    await bridge("session-a", { type: "text", text: "hello", timestamp: 1 });

    expect(publishEngineEvent).toHaveBeenCalledWith(task, {
      type: "assistant_message",
      content: "hello",
      timestamp: 1,
    });
    expect(collectDetached).toHaveBeenCalledWith(task, {
      type: "assistant_message",
      content: "hello",
      timestamp: 1,
    });
    expect(order).toEqual(["publish", "collect"]);
  });
});
