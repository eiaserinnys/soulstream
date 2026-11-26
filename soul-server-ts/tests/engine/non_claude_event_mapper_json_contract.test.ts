import { describe, expect, it, vi } from "vitest";

import { mapAppServerNotification } from
  "../../src/engine/codex_app_server/event_mapper.js";
import { mapThreadEvent } from "../../src/engine/codex_event_mapper.js";
import type { SSEEventPayload } from "../../src/engine/protocol.js";
import { assertRunnerJsonValue } from "../../src/runner/frame_protocol.js";

describe("non-Claude mapper runner JSON contract", () => {
  it.each(codexSdkFixtures)("keeps Codex SDK $name output inside the contract", ({ event }) => {
    assertMapperOutput(mapThreadEvent(event as never), "Codex SDK");
  });

  it.each(codexAppServerFixtures)(
    "keeps Codex app-server $name output inside the contract",
    ({ notification }) => {
      assertMapperOutput(mapAppServerNotification(notification as never), "Codex app-server");
    },
  );

  it("keeps Codex app-server context and completion usage inside the JSON contract", () => {
    const usage = {
      totalTokens: 14_129,
      inputTokens: 14_124,
      cachedInputTokens: 12_288,
      cacheWriteInputTokens: 0,
      outputTokens: 5,
      reasoningOutputTokens: 0,
    };
    const events = mapAppServerNotification(
      {
        method: "turn/completed",
        params: { threadId: "thread-1", turn: appTurn },
      } as never,
      undefined,
      {
        tokenUsage: {
          first: null,
          baseline: {
            totalTokens: 0,
            inputTokens: 0,
            cachedInputTokens: 0,
            cacheWriteInputTokens: 0,
            outputTokens: 0,
            reasoningOutputTokens: 0,
          },
          latest: {
            total: usage,
            last: usage,
            modelContextWindow: 258_400,
          },
        },
      },
    );

    expect(events.map((event) => event.type)).toEqual(["context_usage", "complete"]);
    assertMapperOutput(events, "Codex app-server");
  });

  it("drops unknown Codex app-server notifications and reports their method", () => {
    const onUnknownNotification = vi.fn();
    const events = mapAppServerNotification(
      { method: "future/event", params: {} } as never,
      onUnknownNotification,
    );

    expect(events).toEqual([]);
    expect(onUnknownNotification).toHaveBeenCalledWith("future/event");
  });
});

function assertMapperOutput(events: SSEEventPayload[], mapper: string): void {
  expect(events.length).toBeGreaterThan(0);
  for (const event of events) {
    expect(() => assertRunnerJsonValue(event, `${mapper} mapper output`)).not.toThrow();
  }
}

const codexSdkFixtures = [
  { name: "thread start", event: { type: "thread.started" } },
  { name: "turn completion without usage", event: { type: "turn.completed" } },
  { name: "turn failure", event: { type: "turn.failed", error: {} } },
  { name: "stream error", event: { type: "error" } },
  { name: "agent start without item id", event: { type: "item.started", item: { type: "agent_message" } } },
  { name: "agent update without item id", event: { type: "item.updated", item: { type: "agent_message" } } },
  {
    name: "MCP start without arguments",
    event: { type: "item.started", item: { type: "mcp_tool_call", id: "mcp-1" } },
  },
  {
    name: "command completion",
    event: { type: "item.completed", item: { type: "command_execution", id: "cmd-1" } },
  },
  {
    name: "raw function call",
    event: { type: "response_item", payload: { type: "function_call", call_id: "call-1" } },
  },
];

const appTurn = {
  id: "turn-1",
  items: [],
  itemsView: {},
  status: "completed",
  error: null,
  startedAt: null,
  completedAt: null,
  durationMs: null,
};

const codexAppServerFixtures = [
  {
    name: "thread start",
    notification: { method: "thread/started", params: { thread: { id: "thread-1" } } },
  },
  {
    name: "turn completion without usage",
    notification: { method: "turn/completed", params: { threadId: "thread-1", turn: appTurn } },
  },
  {
    name: "item start without timestamp",
    notification: {
      method: "item/started",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { type: "commandExecution", id: "cmd-1", command: "pwd", cwd: null },
      },
    },
  },
  {
    name: "item completion without timestamp",
    notification: {
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "mcpToolCall",
          id: "mcp-1",
          server: "soulstream",
          tool: "get_session_name",
          arguments: {},
          status: "completed",
          result: {},
          error: null,
        },
      },
    },
  },
  ...["commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "webSearch"].flatMap(
    (type) => [
      {
        name: `${type} start without item id`,
        notification: {
          method: "item/started",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: appServerItemWithoutId(type),
          },
        },
      },
      {
        name: `${type} completion without item id`,
        notification: {
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: appServerItemWithoutId(type),
          },
        },
      },
    ],
  ),
  {
    name: "error without optional IDs",
    notification: { method: "error", params: { error: { message: "failed" } } },
  },
];

function appServerItemWithoutId(type: string): Record<string, unknown> {
  switch (type) {
    case "commandExecution":
      return { type, command: "pwd", cwd: null, status: "completed", exitCode: 0 };
    case "fileChange":
      return { type, changes: [], status: "completed" };
    case "mcpToolCall":
      return {
        type,
        server: "soulstream",
        tool: "get_session_name",
        arguments: {},
        status: "completed",
        result: {},
        error: null,
      };
    case "dynamicToolCall":
      return {
        type,
        toolName: "custom",
        arguments: {},
        status: "completed",
        result: {},
        error: null,
      };
    case "webSearch":
      return { type, query: "runner", status: "completed", result: {} };
    default:
      throw new Error(`Unhandled app-server item fixture: ${type}`);
  }
}
