import { describe, expect, it } from "vitest";

import {
  mapAgentsGuardrailError,
  mapAgentsRunStreamEvent,
} from "../../src/engine/agents_event_mapper.js";
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

  it.each(agentsFixtures)("keeps Agents $name output inside the contract", ({ event }) => {
    const output = event.kind === "guardrail"
      ? mapAgentsGuardrailError(event.value)
      : mapAgentsRunStreamEvent(event.value);
    assertMapperOutput(output, "Agents");
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
  {
    name: "error without optional IDs",
    notification: { method: "error", params: { error: { message: "failed" } } },
  },
  {
    name: "unknown notification",
    notification: { method: "future/event", params: {} },
  },
];

const agentsFixtures: Array<{
  name: string;
  event: { kind: "stream" | "guardrail"; value: unknown };
}> = [
  {
    name: "agent update",
    event: { kind: "stream", value: { type: "agent_updated_stream_event", agent: {} } },
  },
  {
    name: "tool approval without agent name",
    event: {
      kind: "stream",
      value: {
        type: "run_item_stream_event",
        name: "tool_approval_requested",
        item: { rawItem: { callId: "approval-1", name: "Bash" } },
      },
    },
  },
  {
    name: "tool output",
    event: {
      kind: "stream",
      value: {
        type: "run_item_stream_event",
        name: "tool_output",
        item: { rawItem: { callId: "tool-1" } },
      },
    },
  },
  {
    name: "guardrail without output info",
    event: {
      kind: "guardrail",
      value: {
        name: "InputGuardrailTripwireTriggered",
        result: { guardrail: {}, output: {} },
      },
    },
  },
];
