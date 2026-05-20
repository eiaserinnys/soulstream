/**
 * Claude client event → Soulstream SSE event mapping.
 *
 * This mapper is intentionally Claude-specific. Codex ThreadEvent mapping stays in
 * codex_event_mapper.ts because the source event cardinality differs: Python Claude
 * represents one text block as TextDeltaEngineEvent.to_sse() →
 * text_start/text_delta/text_end, while Codex has SDK item lifecycle events.
 */

import type { SSEEventPayload } from "./protocol.js";

export type ClaudeClientEvent =
  | { type: "session"; sessionId: string; pid?: number }
  | { type: "debug"; message: string; timestamp?: number; parentEventId?: ParentEventId }
  | { type: "progress"; text: string; timestamp?: number; parentEventId?: ParentEventId }
  | { type: "text"; text: string; timestamp?: number; parentEventId?: ParentEventId }
  | {
      type: "thinking";
      thinking: string;
      signature?: string;
      timestamp?: number;
      parentEventId?: ParentEventId;
    }
  | {
      type: "tool_start";
      toolName: string;
      toolInput?: Record<string, unknown>;
      toolUseId?: string | null;
      timestamp?: number;
      parentEventId?: ParentEventId;
    }
  | {
      type: "tool_result";
      toolName?: string;
      result?: unknown;
      isError?: boolean;
      toolUseId?: string | null;
      timestamp?: number;
      parentEventId?: ParentEventId;
    }
  | {
      type: "result";
      success: boolean;
      output: string;
      error?: string | null;
      usage?: unknown;
      totalCostUsd?: number | null;
      stopReason?: string | null;
      errors?: string[] | null;
      modelUsage?: Record<string, unknown> | null;
      permissionDenials?: string[] | null;
      timestamp?: number;
      parentEventId?: ParentEventId;
    }
  | {
      type: "context_usage";
      usedTokens: number;
      maxTokens: number;
      percent: number;
      timestamp?: number;
      parentEventId?: ParentEventId;
    }
  | {
      type: "complete";
      result?: string;
      attachments?: string[];
      claudeSessionId?: string;
      usage?: unknown;
      totalCostUsd?: number;
      timestamp?: number;
      parentEventId?: ParentEventId;
    }
  | {
      type: "error";
      message: string;
      fatal?: boolean;
      errorCode?: string;
      timestamp?: number;
      parentEventId?: ParentEventId;
    }
  | {
      type: "prompt_suggestion";
      text: string;
      timestamp?: number;
      parentEventId?: ParentEventId;
    }
  | {
      type: "rate_limit";
      status?: string;
      resetsAt?: string;
      rateLimitType?: string;
      utilization?: number;
      timestamp?: number;
      parentEventId?: ParentEventId;
    }
  | {
      type: "input_request";
      requestId: string;
      toolUseId?: string | null;
      questions: unknown[];
      startedAt?: number;
      timeoutSec?: number;
      timestamp?: number;
      parentEventId?: ParentEventId;
    }
  | {
      type: "input_request_expired";
      requestId: string;
      timestamp?: number;
      parentEventId?: ParentEventId;
    }
  | {
      type: "input_request_responded";
      requestId: string;
      timestamp?: number;
      parentEventId?: ParentEventId;
    }
  | {
      type: "compact";
      trigger: string;
      message: string;
      timestamp?: number;
      parentEventId?: ParentEventId;
    }
  | {
      type: "assistant_error";
      errorType: string;
      model?: string;
      messageId?: string;
      timestamp?: number;
      parentEventId?: ParentEventId;
    }
  | {
      type: "away_summary";
      content: string;
      timestamp?: number;
      parentEventId?: ParentEventId;
    }
  | {
      type: "subagent_start";
      agentId: string;
      agentType: string;
      timestamp?: number;
      parentEventId?: ParentEventId;
    }
  | {
      type: "subagent_stop";
      agentId: string;
      timestamp?: number;
      parentEventId?: ParentEventId;
    };

export interface ClaudeEventMapperOptions {
  fallbackResult?: string;
}

type ParentEventId = string | number | null;

/** Map one Claude client event into zero or more Soulstream SSE payloads. */
export function mapClaudeClientEvent(
  event: ClaudeClientEvent,
  options: ClaudeEventMapperOptions = {},
): SSEEventPayload[] {
  switch (event.type) {
    case "session":
      return [
        asSSE({
          type: "session",
          session_id: event.sessionId,
          ...(event.pid !== undefined ? { pid: event.pid } : {}),
        }),
      ];

    case "debug":
      return [
        asSSE({
          type: "debug",
          message: event.message,
          timestamp: event.timestamp ?? nowEpochSec(),
          ...parentField(event.parentEventId),
        }),
      ];

    case "progress":
      return [
        asSSE({
          type: "progress",
          text: event.text,
        }),
      ];

    case "text": {
      const timestamp = event.timestamp ?? nowEpochSec();
      const parent = parentField(event.parentEventId);
      return [
        asSSE({ type: "text_start", timestamp, ...parent }),
        asSSE({ type: "text_delta", text: event.text, timestamp, ...parent }),
        asSSE({ type: "text_end", timestamp, ...parent }),
      ];
    }

    case "thinking":
      return [
        asSSE({
          type: "thinking",
          thinking: event.thinking,
          signature: event.signature ?? "",
          timestamp: event.timestamp ?? nowEpochSec(),
          ...parentField(event.parentEventId),
        }),
      ];

    case "tool_start":
      return [
        asSSE({
          type: "tool_start",
          tool_name: event.toolName,
          tool_input: event.toolInput ?? {},
          ...(event.toolUseId ? { tool_use_id: event.toolUseId } : {}),
          timestamp: event.timestamp ?? nowEpochSec(),
          ...parentField(event.parentEventId),
        }),
      ];

    case "tool_result":
      return [
        asSSE({
          type: "tool_result",
          tool_name: event.toolName ?? "",
          result: stringifyToolResult(event.result),
          is_error: event.isError ?? false,
          ...(event.toolUseId ? { tool_use_id: event.toolUseId } : {}),
          timestamp: event.timestamp ?? nowEpochSec(),
          ...parentField(event.parentEventId),
        }),
      ];

    case "result":
      return [
        asSSE({
          type: "result",
          success: event.success,
          output: event.output,
          ...(event.error !== undefined ? { error: event.error } : {}),
          ...(event.usage !== undefined ? { usage: event.usage } : {}),
          ...(event.totalCostUsd !== undefined ? { total_cost_usd: event.totalCostUsd } : {}),
          ...(event.stopReason !== undefined ? { stop_reason: event.stopReason } : {}),
          ...(event.errors !== undefined ? { errors: event.errors } : {}),
          ...(event.modelUsage !== undefined ? { model_usage: event.modelUsage } : {}),
          ...(event.permissionDenials !== undefined
            ? { permission_denials: event.permissionDenials }
            : {}),
          timestamp: event.timestamp ?? nowEpochSec(),
          ...parentField(event.parentEventId),
        }),
      ];

    case "context_usage":
      return [
        asSSE({
          type: "context_usage",
          used_tokens: event.usedTokens,
          max_tokens: event.maxTokens,
          percent: event.percent,
        }),
      ];

    case "complete": {
      const result = event.result ?? options.fallbackResult;
      return [
        asSSE({
          type: "complete",
          ...(result !== undefined ? { result } : {}),
          ...(event.attachments !== undefined ? { attachments: event.attachments } : {}),
          ...(event.claudeSessionId !== undefined
            ? { claude_session_id: event.claudeSessionId }
            : {}),
          ...(event.usage !== undefined ? { usage: event.usage } : {}),
          ...(event.totalCostUsd !== undefined ? { total_cost_usd: event.totalCostUsd } : {}),
          timestamp: event.timestamp ?? nowEpochSec(),
          ...parentField(event.parentEventId),
        }),
      ];
    }

    case "error":
      return [
        asSSE({
          type: "error",
          message: event.message,
          fatal: event.fatal ?? true,
          ...(event.errorCode !== undefined ? { error_code: event.errorCode } : {}),
          timestamp: event.timestamp ?? nowEpochSec(),
          ...parentField(event.parentEventId),
        }),
      ];

    case "prompt_suggestion":
      return [
        asSSE({
          type: "prompt_suggestion",
          text: event.text,
          timestamp: event.timestamp ?? nowEpochSec(),
          ...parentField(event.parentEventId),
        }),
      ];

    case "rate_limit":
      return [
        asSSE({
          type: "credential_alert",
          ...(event.utilization !== undefined ? { utilization: event.utilization } : {}),
          ...(event.rateLimitType !== undefined ? { rate_limit_type: event.rateLimitType } : {}),
          ...(event.status !== undefined ? { status: event.status } : {}),
          ...(event.resetsAt !== undefined ? { resets_at: event.resetsAt } : {}),
          timestamp: event.timestamp ?? nowEpochSec(),
          ...parentField(event.parentEventId),
        }),
      ];

    case "input_request":
      return [
        asSSE({
          type: "input_request",
          request_id: event.requestId,
          ...(event.toolUseId ? { tool_use_id: event.toolUseId } : {}),
          questions: event.questions,
          ...(event.startedAt !== undefined ? { started_at: event.startedAt } : {}),
          ...(event.timeoutSec !== undefined ? { timeout_sec: event.timeoutSec } : {}),
          timestamp: event.timestamp ?? nowEpochSec(),
          ...parentField(event.parentEventId),
        }),
      ];

    case "input_request_expired":
      return [
        asSSE({
          type: "input_request_expired",
          request_id: event.requestId,
          timestamp: event.timestamp ?? nowEpochSec(),
          ...parentField(event.parentEventId),
        }),
      ];

    case "input_request_responded":
      return [
        asSSE({
          type: "input_request_responded",
          request_id: event.requestId,
          timestamp: event.timestamp ?? nowEpochSec(),
          ...parentField(event.parentEventId),
        }),
      ];

    case "compact":
      return [
        asSSE({
          type: "compact",
          trigger: event.trigger,
          message: event.message,
          timestamp: event.timestamp ?? nowEpochSec(),
          ...parentField(event.parentEventId),
        }),
      ];

    case "assistant_error":
      return [
        asSSE({
          type: "assistant_error",
          error_type: event.errorType,
          ...(event.model !== undefined ? { model: event.model } : {}),
          ...(event.messageId !== undefined ? { message_id: event.messageId } : {}),
          timestamp: event.timestamp ?? nowEpochSec(),
          ...parentField(event.parentEventId),
        }),
      ];

    case "away_summary":
      return [
        asSSE({
          type: "away_summary",
          content: event.content,
          timestamp: event.timestamp ?? nowEpochSec(),
          ...parentField(event.parentEventId),
        }),
      ];

    case "subagent_start":
      return [
        asSSE({
          type: "subagent_start",
          agent_id: event.agentId,
          agent_type: event.agentType,
          timestamp: event.timestamp ?? nowEpochSec(),
          ...parentField(event.parentEventId),
        }),
      ];

    case "subagent_stop":
      return [
        asSSE({
          type: "subagent_stop",
          agent_id: event.agentId,
          timestamp: event.timestamp ?? nowEpochSec(),
          ...parentField(event.parentEventId),
        }),
      ];
  }
}

function nowEpochSec(): number {
  return Date.now() / 1000;
}

function parentField(parentEventId: ParentEventId | undefined): Record<string, string | number> {
  return parentEventId === undefined || parentEventId === null
    ? {}
    : { parent_event_id: parentEventId };
}

function stringifyToolResult(result: unknown): string {
  if (typeof result === "string") return result;
  if (result === undefined || result === null) return "";
  try {
    const encoded = JSON.stringify(result);
    return encoded ?? String(result);
  } catch {
    return String(result);
  }
}

function asSSE(payload: Record<string, unknown>): SSEEventPayload {
  return payload as unknown as SSEEventPayload;
}
