import type { SSEEventPayload } from "../engine/protocol.js";

export const CLAUDE_CONTEXT_PREEMPTIVE_COMPACT_RATIO = 0.85;
export const CLAUDE_BACKEND_ROLLOVER_LIMIT = 1;
export const CLAUDE_PROMPT_TOO_LONG_ERROR_CODE = "claude_prompt_too_long";

const REPLAY_SAFE_EVENT_TYPES = new Set([
  "session",
  "result",
  "context_usage",
  "error",
  "assistant_error",
  "credential_alert",
  "debug",
  "rate_limit",
  "prompt_suggestion",
]);

export interface ClaudeContextRecoveryObservation {
  promptTooLongMessage?: string;
  replayUnsafeEventObserved: boolean;
  preemptiveCompactNeeded: boolean;
  compactCompleted: boolean;
}

export function createClaudeContextRecoveryObservation(): ClaudeContextRecoveryObservation {
  return {
    replayUnsafeEventObserved: false,
    preemptiveCompactNeeded: false,
    compactCompleted: false,
  };
}

export function observeClaudeContextRecoveryEvent(
  observation: ClaudeContextRecoveryObservation,
  event: SSEEventPayload,
): void {
  const record = event as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : "";
  if (!REPLAY_SAFE_EVENT_TYPES.has(type)) observation.replayUnsafeEventObserved = true;
  if (type === "compact") observation.compactCompleted = true;

  if (
    (type === "error" && record.error_code === CLAUDE_PROMPT_TOO_LONG_ERROR_CODE)
    || (type === "result" && record.terminal_reason === "prompt_too_long")
  ) {
    observation.promptTooLongMessage = firstNonEmptyString(
      record.message,
      record.error,
      record.output,
      "Prompt is too long",
    );
  }

  if (type !== "context_usage") return;
  const usedTokens = finiteNumber(record.used_tokens);
  const maxTokens = finiteNumber(record.max_tokens);
  if (
    usedTokens !== undefined
    && maxTokens !== undefined
    && maxTokens > 0
    && usedTokens / maxTokens >= CLAUDE_CONTEXT_PREEMPTIVE_COMPACT_RATIO
  ) {
    observation.preemptiveCompactNeeded = true;
  }
}

export function fatalPromptTooLongEvent(message: string): SSEEventPayload {
  return {
    type: "error",
    message,
    fatal: true,
    error_code: CLAUDE_PROMPT_TOO_LONG_ERROR_CODE,
  } as SSEEventPayload;
}

export function claudeBackendRolloverMetadataEntry(
  attempts: number,
  previousSessionId: string,
): Record<string, unknown> {
  return {
    type: "claude_backend_rollover",
    value: {
      attempts,
      reason: "prompt_too_long",
      previous_session_id: previousSessionId,
      attempted_at: new Date().toISOString(),
    },
  };
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function firstNonEmptyString(...values: unknown[]): string {
  return values.find((value): value is string =>
    typeof value === "string" && value.length > 0,
  ) ?? "Prompt is too long";
}
