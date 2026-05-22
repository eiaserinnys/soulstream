import type { SSEEventPayload } from "../protocol.js";
import type {
  AppServerNotification,
  AppServerThread,
  AppServerThreadItem,
  AppServerTurn,
  AppServerTurnError,
  JsonObject,
} from "./protocol.js";

function nowEpochSec(): number {
  return Date.now() / 1000;
}

function timestampFromMs(ms: number | undefined): number {
  return typeof ms === "number" ? ms / 1000 : nowEpochSec();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fieldString(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const raw = value[key];
  return typeof raw === "string" ? raw : undefined;
}

function jsonStringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return String(value);
  }
}

function errorMessage(error: AppServerTurnError | null | undefined): string {
  return error?.message ?? "Codex app-server turn failed";
}

function isTurnError(value: unknown): value is AppServerTurnError {
  return isRecord(value) && typeof value.message === "string";
}

function rawContext(
  method: string,
  params: { threadId?: string; turnId?: string; itemId?: string },
): Record<string, unknown> {
  return {
    raw_event_type: method,
    ...(params.threadId ? { thread_id: params.threadId } : {}),
    ...(params.turnId ? { turn_id: params.turnId } : {}),
    ...(params.itemId ? { tool_use_id: params.itemId } : {}),
  };
}

export function mapAppServerNotification(
  notification: AppServerNotification,
): SSEEventPayload[] {
  switch (notification.method) {
    case "thread/started": {
      const params = notification.params as { thread: AppServerThread };
      return [
        {
          type: "session",
          session_id: params.thread.id,
        } as SSEEventPayload,
      ];
    }

    case "turn/started": {
      const params = notification.params as { threadId: string; turn: AppServerTurn };
      return [
        {
          type: "progress",
          text: "Codex turn started",
          timestamp: nowEpochSec(),
          ...rawContext(notification.method, {
            threadId: params.threadId,
            turnId: params.turn.id,
          }),
        } as SSEEventPayload,
      ];
    }

    case "turn/completed": {
      const { threadId, turn } = notification.params as {
        threadId: string;
        turn: AppServerTurn;
      };
      if (turn.status === "failed") {
        return [
          {
            type: "error",
            message: errorMessage(turn.error),
            fatal: false,
            timestamp: nowEpochSec(),
            error_info: turn.error?.codexErrorInfo ?? null,
            additional_details: turn.error?.additionalDetails ?? null,
            ...rawContext(notification.method, { threadId, turnId: turn.id }),
          } as SSEEventPayload,
        ];
      }
      return [
        {
          type: "complete",
          timestamp: nowEpochSec(),
          status: turn.status,
          duration_ms: turn.durationMs,
          ...rawContext(notification.method, { threadId, turnId: turn.id }),
        } as SSEEventPayload,
      ];
    }

    case "item/started": {
      const params = notification.params as {
        threadId: string;
        turnId: string;
        startedAtMs?: number;
        item: AppServerThreadItem;
      };
      return mapItemStarted(params.item, {
        method: notification.method,
        threadId: params.threadId,
        turnId: params.turnId,
        timestamp: timestampFromMs(params.startedAtMs),
      });
    }

    case "item/agentMessage/delta": {
      const params = notification.params as {
        threadId: string;
        turnId: string;
        itemId: string;
        delta: string;
      };
      return [
        {
          type: "text_delta",
          text: params.delta,
          timestamp: nowEpochSec(),
          ...rawContext(notification.method, params),
        } as SSEEventPayload,
      ];
    }

    case "command/exec/outputDelta":
    case "item/commandExecution/outputDelta":
    case "item/fileChange/outputDelta": {
      const params = notification.params as {
        threadId: string;
        turnId: string;
        itemId: string;
        delta: string;
      };
      return [
        {
          type: "progress",
          text: params.delta,
          timestamp: nowEpochSec(),
          ...rawContext(notification.method, params),
        } as SSEEventPayload,
      ];
    }

    case "item/mcpToolCall/progress":
    case "item/reasoning/textDelta":
    case "item/reasoning/summaryTextDelta": {
      const params = notification.params as {
        threadId: string;
        turnId: string;
        itemId: string;
        message?: string;
        delta?: string;
      };
      return [
        {
          type: notification.method.startsWith("item/reasoning/")
            ? "thinking"
            : "progress",
          text: params.delta ?? params.message ?? "",
          timestamp: nowEpochSec(),
          ...rawContext(notification.method, params),
        } as SSEEventPayload,
      ];
    }

    case "item/completed": {
      const params = notification.params as {
        threadId: string;
        turnId: string;
        completedAtMs?: number;
        item: AppServerThreadItem;
      };
      return mapItemCompleted(params.item, {
        method: notification.method,
        threadId: params.threadId,
        turnId: params.turnId,
        timestamp: timestampFromMs(params.completedAtMs),
      });
    }

    case "rawResponseItem/completed": {
      const params = notification.params as {
        threadId: string;
        turnId: string;
        item: JsonObject;
      };
      return mapRawResponseItem(params.item, {
        method: notification.method,
        threadId: params.threadId,
        turnId: params.turnId,
      });
    }

    case "error": {
      const params = notification.params as {
        threadId?: string;
        turnId?: string;
        willRetry?: boolean;
        error: AppServerTurnError;
      };
      return [
        {
          type: "error",
          message: errorMessage(params.error),
          fatal: false,
          will_retry: params.willRetry ?? false,
          timestamp: nowEpochSec(),
          error_info: params.error.codexErrorInfo ?? null,
          additional_details: params.error.additionalDetails ?? null,
          ...rawContext(notification.method, params),
        } as SSEEventPayload,
      ];
    }

    default:
      return [
        {
          type: "debug",
          message: `Ignored Codex app-server notification: ${notification.method}`,
          timestamp: nowEpochSec(),
          raw_event_type: notification.method,
        } as SSEEventPayload,
      ];
  }
}

function mapItemStarted(
  item: AppServerThreadItem,
  context: { method: string; threadId: string; turnId: string; timestamp: number },
): SSEEventPayload[] {
  switch (item.type) {
    case "agentMessage":
      return [{ type: "text_start", timestamp: context.timestamp } as SSEEventPayload];

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

function mapItemCompleted(
  item: AppServerThreadItem,
  context: { method: string; threadId: string; turnId: string; timestamp: number },
): SSEEventPayload[] {
  switch (item.type) {
    case "agentMessage":
      return [
        {
          type: "text_end",
          timestamp: context.timestamp,
        } as SSEEventPayload,
      ];

    case "reasoning": {
      const summary = Array.isArray(item.summary) ? item.summary.join("\n") : "";
      return [
        {
          type: "thinking",
          text: item.text ?? summary,
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

function mapRawResponseItem(
  item: JsonObject,
  context: { method: string; threadId: string; turnId: string },
): SSEEventPayload[] {
  const type = fieldString(item, "type");
  if (type === "message") {
    const text = extractResponseText(item);
    if (!text) return [];
    const timestamp = nowEpochSec();
    return [
      { type: "text_start", timestamp, ...rawContext(context.method, context) },
      { type: "text_delta", text, timestamp, ...rawContext(context.method, context) },
      { type: "text_end", timestamp, ...rawContext(context.method, context) },
    ] as SSEEventPayload[];
  }
  if (type === "reasoning") {
    return [
      {
        type: "thinking",
        text: jsonStringify(item),
        timestamp: nowEpochSec(),
        ...rawContext(context.method, context),
      } as SSEEventPayload,
    ];
  }
  if (type === "function_call" || type === "custom_tool_call") {
    const id = fieldString(item, "call_id") ?? fieldString(item, "id") ?? "tool";
    return [
      {
        type: "tool_start",
        tool_use_id: id,
        tool_name: fieldString(item, "name") ?? type,
        tool_input: fieldString(item, "arguments") ?? fieldString(item, "input") ?? {},
        timestamp: nowEpochSec(),
        ...rawContext(context.method, { ...context, itemId: id }),
      } as SSEEventPayload,
    ];
  }
  return [
    {
      type: "debug",
      message: `Ignored Codex app-server raw response item: ${type ?? "unknown"}`,
      timestamp: nowEpochSec(),
      raw_event_type: context.method,
    } as SSEEventPayload,
  ];
}

function extractResponseText(item: JsonObject): string {
  const content = item.content;
  if (!Array.isArray(content)) return "";
  const chunks: string[] = [];
  for (const part of content) {
    const text = fieldString(part, "text");
    if (text) chunks.push(text);
  }
  return chunks.join("");
}
