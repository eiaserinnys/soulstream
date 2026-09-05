import { describe, expect, it } from "vitest";

import { mapAppServerNotification } from "../../../src/engine/codex_app_server/event_mapper.js";
import type {
  AppServerNotification,
  AppServerThreadItem,
  AppServerTurn,
} from "../../../src/engine/codex_app_server/protocol.js";

function turn(
  id: string,
  status: AppServerTurn["status"] = "inProgress",
  error: AppServerTurn["error"] = null,
): AppServerTurn {
  return {
    id,
    items: [],
    itemsView: { kind: "full" },
    status,
    error,
    startedAt: 1,
    completedAt: status === "inProgress" ? null : 2,
    durationMs: status === "inProgress" ? null : 1000,
  };
}

type StructuredToolKind = "mcpToolCall" | "dynamicToolCall" | "webSearch";

const TOOL_RESULT_CASES = [
  { label: "object", present: true, value: { cards: [{ id: "card-1" }] } },
  { label: "array", present: true, value: [{ type: "text", text: "kept" }] },
  { label: "string", present: true, value: "already text" },
  { label: "number scalar", present: true, value: 0 },
  { label: "boolean scalar", present: true, value: false },
  { label: "null", present: true, value: null },
  { label: "missing", present: false, value: undefined },
] as const;

function structuredToolItem(
  kind: StructuredToolKind,
  options: {
    present?: boolean;
    result?: unknown;
    status?: string;
    error?: { message: string; codexErrorInfo: string; additionalDetails: unknown } | null;
  } = {},
): AppServerThreadItem {
  const result = options.present === false ? {} : { result: options.result };
  const status = options.status ?? "completed";
  if (kind === "mcpToolCall") {
    return {
      type: kind,
      id: "tool-1",
      server: "atom",
      tool: "search_cards",
      arguments: { query: "x" },
      status,
      error: options.error ?? null,
      ...result,
    };
  }
  if (kind === "dynamicToolCall") {
    return {
      type: kind,
      id: "tool-1",
      toolName: "dynamic_tool",
      arguments: { query: "x" },
      status,
      error: options.error ?? null,
      ...result,
    };
  }
  return {
    type: kind,
    id: "tool-1",
    query: "x",
    status,
    ...result,
  };
}

function mapCompletedTool(item: AppServerThreadItem) {
  return mapAppServerNotification({
    method: "item/completed",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      completedAtMs: 2000,
      item,
    },
  })[0]!;
}

describe("Codex app-server notification mapper", () => {
  it("thread/started maps to Soulstream session event", () => {
    const out = mapAppServerNotification({
      method: "thread/started",
      params: { thread: { id: "thread-1" } },
    });
    expect(out).toEqual([{ type: "session", session_id: "thread-1" }]);
  });

  it("turn/started maps to progress and turn/completed maps to complete", () => {
    expect(
      mapAppServerNotification({
        method: "turn/started",
        params: { threadId: "thread-1", turn: turn("turn-1") },
      })[0],
    ).toMatchObject({
      type: "progress",
      text: "Codex turn started",
      raw_event_type: "turn/started",
      thread_id: "thread-1",
      turn_id: "turn-1",
    });

    expect(
      mapAppServerNotification({
        method: "turn/completed",
        params: { threadId: "thread-1", turn: turn("turn-1", "completed") },
      })[0],
    ).toMatchObject({
      type: "complete",
      raw_event_type: "turn/completed",
      thread_id: "thread-1",
      turn_id: "turn-1",
    });
  });

  it("turn/completed preserves codex usage on the complete event", () => {
    const completed = turn("turn-1", "completed");
    completed.usage = {
      input_tokens: 11,
      output_tokens: 13,
    };

    const out = mapAppServerNotification({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: completed },
    });

    expect(out[0]).toMatchObject({
      type: "complete",
      raw_event_type: "turn/completed",
      usage: {
        input_tokens: 11,
        output_tokens: 13,
      },
    });
  });

  it("failed turn completion maps to non-fatal error", () => {
    const out = mapAppServerNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: turn("turn-1", "failed", {
          message: "rate limit",
          codexErrorInfo: "usageLimitExceeded",
          additionalDetails: null,
        }),
      },
    });
    expect(out[0]).toMatchObject({
      type: "error",
      message: "rate limit",
      fatal: false,
      raw_event_type: "turn/completed",
    });
  });

  it("agent message lifecycle keeps live deltas live-only and emits final assistant_message", () => {
    expect(
      mapAppServerNotification({
        method: "item/started",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          startedAtMs: 1000,
          item: {
            type: "agentMessage",
            id: "item-1",
            text: "",
            phase: null,
            memoryCitation: null,
          },
        },
      }),
    ).toEqual([
      {
        type: "text_start",
        timestamp: 1,
        raw_event_type: "item/started",
        thread_id: "thread-1",
        turn_id: "turn-1",
        tool_use_id: "item-1",
        _live_only: true,
      },
    ]);

    expect(
      mapAppServerNotification({
        method: "item/agentMessage/delta",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "item-1",
          delta: "hello",
        },
      })[0],
    ).toMatchObject({
      type: "text_delta",
      text: "hello",
      raw_event_type: "item/agentMessage/delta",
      tool_use_id: "item-1",
      _live_only: true,
    });

    expect(
      mapAppServerNotification({
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          completedAtMs: 2000,
          item: {
            type: "agentMessage",
            id: "item-1",
            text: "hello",
            phase: null,
            memoryCitation: null,
          },
        },
      }),
    ).toEqual([
      {
        type: "assistant_message",
        content: "hello",
        timestamp: 2,
        raw_event_type: "item/completed",
        thread_id: "thread-1",
        turn_id: "turn-1",
        tool_use_id: "item-1",
        _final_for_live_stream: true,
      },
      {
        type: "text_end",
        timestamp: 2,
        raw_event_type: "item/completed",
        thread_id: "thread-1",
        turn_id: "turn-1",
        tool_use_id: "item-1",
        _live_only: true,
      },
    ]);
  });

  it("empty reasoning notifications are skipped but non-empty thinking remains", () => {
    expect(
      mapAppServerNotification({
        method: "item/reasoning/textDelta",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "reasoning-1",
          delta: "   ",
        },
      }),
    ).toEqual([]);

    expect(
      mapAppServerNotification({
        method: "item/reasoning/summaryTextDelta",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "reasoning-1",
          delta: "I should inspect the stream path.",
        },
      })[0],
    ).toMatchObject({
      type: "thinking",
      text: "I should inspect the stream path.",
      raw_event_type: "item/reasoning/summaryTextDelta",
    });
  });

  it("empty completed reasoning items do not create placeholder thinking", () => {
    expect(
      mapAppServerNotification({
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          completedAtMs: 2000,
          item: {
            type: "reasoning",
            id: "reasoning-1",
            text: "   ",
            summary: ["..."],
          },
        },
      }),
    ).toEqual([]);

    expect(
      mapAppServerNotification({
        method: "rawResponseItem/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: { type: "reasoning", text: "Reviewed the stream." },
        },
      })[0],
    ).toMatchObject({ type: "thinking", text: "Reviewed the stream." });
  });

  it("command execution start/output/complete maps without marking output deltas complete", () => {
    const started = mapAppServerNotification({
      method: "item/started",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        startedAtMs: 1000,
        item: {
          type: "commandExecution",
          id: "cmd-1",
          command: "pnpm test",
          cwd: "/work",
          processId: null,
          source: "agent",
          status: "inProgress",
          commandActions: [],
          aggregatedOutput: null,
          exitCode: null,
          durationMs: null,
        },
      },
    });
    expect(started[0]).toMatchObject({
      type: "tool_start",
      tool_use_id: "cmd-1",
      tool_name: "command",
      tool_input: { command: "pnpm test" },
    });

    const delta = mapAppServerNotification({
      method: "item/commandExecution/outputDelta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "cmd-1",
        delta: "stdout chunk",
      },
    });
    expect(delta[0]).toMatchObject({
      type: "progress",
      raw_event_type: "item/commandExecution/outputDelta",
      tool_use_id: "cmd-1",
      text: "stdout chunk",
    });

    const completed = mapAppServerNotification({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        completedAtMs: 3000,
        item: {
          type: "commandExecution",
          id: "cmd-1",
          command: "pnpm test",
          cwd: "/work",
          processId: null,
          source: "agent",
          status: "completed",
          commandActions: [],
          aggregatedOutput: "passed",
          exitCode: 0,
          durationMs: 2000,
        },
      },
    });
    expect(completed[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "cmd-1",
      tool_name: "command",
      result: "passed",
      is_error: false,
    });
  });

  it("mcp tool call start and complete maps to tool events", () => {
    const start = mapAppServerNotification({
      method: "item/started",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        startedAtMs: 1000,
        item: {
          type: "mcpToolCall",
          id: "mcp-1",
          server: "atom",
          tool: "search_cards",
          status: "inProgress",
          arguments: { query: "x" },
          pluginId: null,
          result: null,
          error: null,
          durationMs: null,
        },
      },
    });
    expect(start[0]).toMatchObject({
      type: "tool_start",
      tool_use_id: "mcp-1",
      tool_name: "mcp/atom/search_cards",
      tool_input: { query: "x" },
    });

    const complete = mapAppServerNotification({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        completedAtMs: 2000,
        item: {
          type: "mcpToolCall",
          id: "mcp-1",
          server: "atom",
          tool: "search_cards",
          status: "completed",
          arguments: { query: "x" },
          pluginId: null,
          result: { cards: [] },
          error: null,
          durationMs: 1000,
        },
      },
    });
    expect(complete[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "mcp-1",
      tool_name: "mcp/atom/search_cards",
      result: { cards: [] },
      is_error: false,
    });
  });

  describe("structured Codex tool results", () => {
    for (const kind of ["mcpToolCall", "dynamicToolCall", "webSearch"] as const) {
      it.each(TOOL_RESULT_CASES)(
        `${kind} preserves $label without changing JSON value kind`,
        ({ present, value }) => {
          const event = mapCompletedTool(structuredToolItem(kind, { present, result: value }));

          expect(event).toMatchObject({ type: "tool_result", is_error: false });
          if (present) {
            expect(event).toHaveProperty("result");
            expect((event as Record<string, unknown>).result).toEqual(value);
          } else {
            expect(event).not.toHaveProperty("result");
          }
        },
      );

      it(`${kind} keeps a failed result when no error object exists`, () => {
        const result = { partial: true, detail: "failed without error object" };
        const event = mapCompletedTool(structuredToolItem(kind, {
          result,
          status: "failed",
        }));

        expect(event).toMatchObject({
          type: "tool_result",
          result,
          is_error: true,
        });
      });
    }

    it.each(["mcpToolCall", "dynamicToolCall"] as const)(
      "%s keeps the existing error.message result contract",
      (kind) => {
        const event = mapCompletedTool(structuredToolItem(kind, {
          result: { ignored: "because the error owns the result text" },
          status: "failed",
          error: {
            message: "explicit tool error",
            codexErrorInfo: "other",
            additionalDetails: null,
          },
        }));

        expect(event).toMatchObject({
          type: "tool_result",
          result: "explicit tool error",
          is_error: true,
        });
      },
    );
  });

  it("error notification maps explicitly and unknown notification becomes ignored debug", () => {
    expect(
      mapAppServerNotification({
        method: "error",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          willRetry: false,
          error: {
            message: "boom",
            codexErrorInfo: "other",
            additionalDetails: "detail",
          },
        },
      })[0],
    ).toMatchObject({
      type: "error",
      message: "boom",
      fatal: false,
      raw_event_type: "error",
    });

    const ignored = mapAppServerNotification({
      method: "future/notification",
      params: { value: 1 },
    } as AppServerNotification);
    expect(ignored[0]).toMatchObject({
      type: "debug",
      message: "Ignored Codex app-server notification: future/notification",
      raw_event_type: "future/notification",
    });
  });
});
