import { describe, expect, it, vi } from "vitest";

import { applyRunnerHostCall } from
  "../../src/runner/runner_process_runtime_factory.js";

describe("applyRunnerHostCall", () => {
  it("threads correlation to all six mutating owner operations", async () => {
    const sessionStore = {
      appendIdempotent: vi.fn(async () => undefined),
      deleteIdempotent: vi.fn(async () => undefined),
    };
    const snapshots = {
      persistRunState: vi.fn(async () => undefined),
      persistSessionItems: vi.fn(async () => undefined),
    };
    const observeClaudeRuntime = vi.fn(async () => true);
    const publishDetachedClaudeEvent = vi.fn(async () => undefined);
    const options = {
      sessionStore,
      observeClaudeRuntime,
      publishDetachedClaudeEvent,
    } as never;
    const key = { projectKey: "project-a", sessionId: "sdk-session-a" };
    const entries = [{ type: "user", message: { content: "hello" } }];
    const event = { type: "text", text: "hello", timestamp: 1 };
    const calls = [
      { service: "session_store" as const, operation: "append", args: [key, entries] },
      { service: "session_store" as const, operation: "delete", args: [key] },
      {
        service: "snapshot" as const,
        operation: "persistRunState",
        args: ["session-a", { backendId: "openai-agents", serialized: "state" }],
      },
      {
        service: "snapshot" as const,
        operation: "persistSessionItems",
        args: ["session-a", { backendId: "openai-agents", items: [] }],
      },
      { service: "claude_runtime" as const, operation: "observe", args: ["session-a", event] },
      { service: "detached_event" as const, operation: "publish", args: ["session-a", event] },
    ];

    for (const [index, call] of calls.entries()) {
      await applyRunnerHostCall(
        { ...call, correlationId: `host:${index}` },
        "session-a",
        snapshots,
        options,
      );
    }

    expect(sessionStore.appendIdempotent).toHaveBeenCalledWith(
      key,
      entries,
      "host:0",
      "session-a",
    );
    expect(sessionStore.deleteIdempotent).toHaveBeenCalledWith(
      key,
      "host:1",
      "session-a",
    );
    expect(snapshots.persistRunState).toHaveBeenCalledWith(
      { backendId: "openai-agents", serialized: "state" },
      "host:2",
    );
    expect(snapshots.persistSessionItems).toHaveBeenCalledWith(
      { backendId: "openai-agents", items: [] },
      "host:3",
    );
    expect(observeClaudeRuntime).toHaveBeenCalledWith("session-a", event, "host:4");
    expect(publishDetachedClaudeEvent).toHaveBeenCalledWith("session-a", event, "host:5");
  });
});
