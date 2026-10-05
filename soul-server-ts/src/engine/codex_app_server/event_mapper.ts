import type { SSEEventPayload } from "../protocol.js";
import { CODEX_USAGE_LIMIT_ERROR_CODE } from "../usage_limit_stop.js";
import type {
  AppServerNotification,
  AppServerThread,
  AppServerThreadItem,
  AppServerTurn,
  AppServerTurnError,
} from "./protocol.js";
import {
  codexContextUsagePayload,
  codexTurnUsage,
  errorMessage,
  nowEpochSec,
  rawContext,
  timestampFromMs,
} from "./event_mapper_helpers.js";
import type { CodexTurnTokenUsage } from "./event_mapper_helpers.js";
import { codexTurnCostUsd } from "../list_price.js";
import { mapItemCompleted, mapItemStarted } from "./item_mapper.js";
import { firstMeaningfulText } from "./text_sanitizer.js";
import { isUsageLimitTurnError } from "./usage_limit.js";

export function mapAppServerNotification(
  notification: AppServerNotification,
  onUnknownNotification?: (method: string) => void,
  turnContext?: { tokenUsage?: CodexTurnTokenUsage | null; model?: string | null },
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
      const { threadId, turn, willRetry } = notification.params as {
        threadId: string;
        turn: AppServerTurn;
        willRetry?: boolean;
      };
      const tokenUsage = turnContext?.tokenUsage ?? undefined;
      const model = turnContext?.model ?? undefined;
      const contextUsage = codexContextUsagePayload(tokenUsage);
      const contextPayloads = contextUsage ? [contextUsage as SSEEventPayload] : [];
      if (turn.status === "failed") {
        const isUsageLimit = willRetry !== true && isUsageLimitTurnError(turn.error);
        return [
          ...contextPayloads,
          {
            type: "error",
            message: errorMessage(turn.error),
            fatal: isUsageLimit,
            ...(isUsageLimit ? { error_code: CODEX_USAGE_LIMIT_ERROR_CODE } : {}),
            timestamp: nowEpochSec(),
            error_info: turn.error?.codexErrorInfo ?? null,
            additional_details: turn.error?.additionalDetails ?? null,
            ...rawContext(notification.method, { threadId, turnId: turn.id }),
          } as SSEEventPayload,
        ];
      }
      const finalAgentMessage = [...turn.items]
        .reverse()
        .find((item) => item.type === "agentMessage");
      const usage = tokenUsage ? codexTurnUsage(tokenUsage) : undefined;
      const turnCostUsd = usage ? codexTurnCostUsd(usage, model) : undefined;
      return [
        ...contextPayloads,
        {
          type: "complete",
          ...(finalAgentMessage ? { result: finalAgentMessage.text } : {}),
          timestamp: nowEpochSec(),
          status: turn.status,
          duration_ms: turn.durationMs,
          ...(usage ? { usage } : {}),
          ...(model !== undefined ? { model } : {}),
          ...(turnCostUsd !== undefined ? { turn_cost_usd: turnCostUsd } : {}),
          ...rawContext(notification.method, { threadId, turnId: turn.id }),
        } as SSEEventPayload,
      ];
    }

    case "thread/tokenUsage/updated":
      return [];

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
          _live_only: true,
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
          _live_only: true,
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

    case "error": {
      const params = notification.params as {
        threadId?: string;
        turnId?: string;
        willRetry?: boolean;
        error: AppServerTurnError;
      };
      const isUsageLimit =
        params.willRetry !== true && isUsageLimitTurnError(params.error);
      return [
        {
          type: "error",
          message: errorMessage(params.error),
          fatal: isUsageLimit,
          will_retry: params.willRetry ?? false,
          ...(isUsageLimit ? { error_code: CODEX_USAGE_LIMIT_ERROR_CODE } : {}),
          timestamp: nowEpochSec(),
          error_info: params.error.codexErrorInfo ?? null,
          additional_details: params.error.additionalDetails ?? null,
          ...rawContext(notification.method, params),
        } as SSEEventPayload,
      ];
    }

    default:
      onUnknownNotification?.(notification.method);
      return [];
  }
}
