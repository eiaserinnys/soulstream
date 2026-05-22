import type { SSEEventPayload } from "../protocol.js";
import type { AppServerThreadItem } from "./protocol.js";
import {
  errorMessage,
  isTurnError,
  jsonStringify,
  rawContext,
} from "./event_mapper_helpers.js";
import { firstMeaningfulText } from "./text_sanitizer.js";

type ItemMappingContext = {
  method: string;
  threadId: string;
  turnId: string;
  timestamp: number;
};

export function mapItemStarted(
  item: AppServerThreadItem,
  context: ItemMappingContext,
): SSEEventPayload[] {
  switch (item.type) {
    case "agentMessage":
      return [
        {
          type: "text_start",
          timestamp: context.timestamp,
          _live_only: true,
          ...rawContext(context.method, {
            threadId: context.threadId,
            turnId: context.turnId,
            itemId: item.id,
          }),
        } as SSEEventPayload,
      ];

    case "commandExecution":
      return [
        {
          type: "tool_start",
          tool_use_id: item.id,
          tool_name: "command",
          tool_input: { command: item.command, cwd: item.cwd ?? null },
          timestamp: context.timestamp,
          ...rawContext(context.method, context),
        } as SSEEventPayload,
      ];

    case "fileChange":
      return [
        {
          type: "tool_start",
          tool_use_id: item.id,
          tool_name: "file_change",
          tool_input: { changes_count: Array.isArray(item.changes) ? item.changes.length : 0 },
          timestamp: context.timestamp,
          ...rawContext(context.method, context),
        } as SSEEventPayload,
      ];

    case "mcpToolCall":
      return [
        {
          type: "tool_start",
          tool_use_id: item.id,
          tool_name: `mcp/${item.server}/${item.tool}`,
          tool_input: item.arguments ?? {},
          timestamp: context.timestamp,
          ...rawContext(context.method, context),
        } as SSEEventPayload,
      ];

    case "dynamicToolCall":
      return [
        {
          type: "tool_start",
          tool_use_id: item.id,
          tool_name: item.toolName ?? "dynamic_tool",
          tool_input: item.arguments ?? {},
          timestamp: context.timestamp,
          ...rawContext(context.method, context),
        } as SSEEventPayload,
      ];

    case "webSearch":
      return [
        {
          type: "tool_start",
          tool_use_id: item.id,
          tool_name: "web_search",
          tool_input: { query: item.query ?? "" },
          timestamp: context.timestamp,
          ...rawContext(context.method, context),
        } as SSEEventPayload,
      ];

    default:
      return [];
  }
}

export function mapItemCompleted(
  item: AppServerThreadItem,
  context: ItemMappingContext,
): SSEEventPayload[] {
  switch (item.type) {
    case "agentMessage": {
      const meta = {
        ...rawContext(context.method, {
          threadId: context.threadId,
          turnId: context.turnId,
          itemId: item.id,
        }),
      };
      const end = { type: "text_end", timestamp: context.timestamp, _live_only: true, ...meta } as SSEEventPayload;
      const text = firstMeaningfulText(item.text);
      if (!text) return [end];
      return [
        {
          type: "assistant_message",
          content: text,
          timestamp: context.timestamp,
          _final_for_live_stream: true,
          ...meta,
        } as SSEEventPayload,
        end,
      ];
    }

    case "reasoning": {
      const summary = Array.isArray(item.summary) ? item.summary.join("\n") : "";
      const text = firstMeaningfulText(item.text, summary);
      if (!text) return [];
      return [
        {
          type: "thinking",
          text,
          timestamp: context.timestamp,
          ...rawContext(context.method, context),
        } as SSEEventPayload,
      ];
    }

    case "commandExecution":
      return [
        {
          type: "tool_result",
          tool_use_id: item.id,
          tool_name: "command",
          result: item.aggregatedOutput ?? "",
          is_error: item.status === "failed" || (item.exitCode ?? 0) !== 0,
          timestamp: context.timestamp,
          ...rawContext(context.method, context),
        } as SSEEventPayload,
      ];

    case "fileChange":
      return [
        {
          type: "tool_result",
          tool_use_id: item.id,
          tool_name: "file_change",
          result: jsonStringify(item.changes ?? []),
          is_error: item.status === "failed",
          timestamp: context.timestamp,
          ...rawContext(context.method, context),
        } as SSEEventPayload,
      ];

    case "mcpToolCall": {
      const error = isTurnError(item.error) ? item.error : null;
      return [
        {
          type: "tool_result",
          tool_use_id: item.id,
          tool_name: `mcp/${item.server}/${item.tool}`,
          result: error ? errorMessage(error) : jsonStringify(item.result),
          is_error: Boolean(error) || item.status === "failed",
          timestamp: context.timestamp,
          ...rawContext(context.method, context),
        } as SSEEventPayload,
      ];
    }

    case "dynamicToolCall": {
      const error = isTurnError(item.error) ? item.error : null;
      return [
        {
          type: "tool_result",
          tool_use_id: item.id,
          tool_name: item.toolName ?? "dynamic_tool",
          result: error ? errorMessage(error) : jsonStringify(item.result),
          is_error: Boolean(error) || item.status === "failed",
          timestamp: context.timestamp,
          ...rawContext(context.method, context),
        } as SSEEventPayload,
      ];
    }

    case "webSearch":
      return [
        {
          type: "tool_result",
          tool_use_id: item.id,
          tool_name: "web_search",
          result: jsonStringify(item.result),
          is_error: item.status === "failed",
          timestamp: context.timestamp,
          ...rawContext(context.method, context),
        } as SSEEventPayload,
      ];

    case "plan":
      return [
        {
          type: "progress",
          text: item.text ?? "",
          timestamp: context.timestamp,
          ...rawContext(context.method, context),
        } as SSEEventPayload,
      ];

    default:
      return [];
  }
}
