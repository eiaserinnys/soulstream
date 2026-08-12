import type { SSEEventPayload } from "../engine/protocol.js";

export const CLAUDE_CONTEXT_PREEMPTIVE_COMPACT_RATIO = 0.85;
export const CLAUDE_CONTEXT_ESTIMATED_CHARS_PER_TOKEN = 2;
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
  latestContextUsage?: ClaudeContextUsage;
}

export interface ClaudeContextUsage {
  usedTokens: number;
  maxTokens: number;
}

export interface ClaudeEstimatedTurnInput {
  prompt: string;
  systemPrompt?: string;
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
  ) {
    observation.latestContextUsage = { usedTokens, maxTokens };
    observation.preemptiveCompactNeeded = shouldPreemptivelyCompact(
      observation.latestContextUsage,
      0,
    );
  }
}

export function estimateClaudeTurnInputTokens(input: ClaudeEstimatedTurnInput): number {
  const estimatedCharacters = input.prompt.length + (input.systemPrompt?.length ?? 0);
  return Math.ceil(estimatedCharacters / CLAUDE_CONTEXT_ESTIMATED_CHARS_PER_TOKEN);
}

export function shouldPreemptivelyCompact(
  usage: ClaudeContextUsage | undefined,
  incomingEstimatedTokens: number,
): boolean {
  if (!usage || usage.maxTokens <= 0) return false;
  return (usage.usedTokens + Math.max(0, incomingEstimatedTokens)) / usage.maxTokens
    >= CLAUDE_CONTEXT_PREEMPTIVE_COMPACT_RATIO;
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
