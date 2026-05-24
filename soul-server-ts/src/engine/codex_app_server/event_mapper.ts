import type { SSEEventPayload } from "../protocol.js";
import type {
  AppServerNotification,
  AppServerThread,
  AppServerThreadItem,
  AppServerTurn,
  AppServerTurnError,
  JsonObject,
} from "./protocol.js";
import {
  errorMessage,
  fieldString,
  nowEpochSec,
  rawContext,
  timestampFromMs,
} from "./event_mapper_helpers.js";
import { mapItemCompleted, mapItemStarted } from "./item_mapper.js";
import { firstMeaningfulText } from "./text_sanitizer.js";

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
          _live_only: true,
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
      const isReasoning = notification.method.startsWith("item/reasoning/");
      const text = isReasoning ? firstMeaningfulText(params.delta, params.message) : params.delta ?? params.message ?? "";
      if (isReasoning && !text) return [];
      return [
        {
          type: isReasoning ? "thinking" : "progress",
          text,
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
      {
        type: "assistant_message",
        content: text,
        timestamp,
        ...rawContext(context.method, context),
      },
    ] as SSEEventPayload[];
  }
  if (type === "reasoning") {
    const text = extractReasoningText(item);
    if (!text) return [];
    return [
      {
        type: "thinking",
        text,
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

function extractReasoningText(item: JsonObject): string {
  return firstMeaningfulText(fieldString(item, "text"), Array.isArray(item.summary) ? item.summary.join("\n") : "", extractResponseText(item));
}
