import { makeContextUsagePayload, type ContextUsagePayload } from "../context_usage.js";
import type {
  AppServerThreadTokenUsage,
  AppServerTokenUsageBreakdown,
  AppServerTurnError,
} from "./protocol.js";

export interface CodexTurnTokenUsage {
  baseline: AppServerTokenUsageBreakdown;
  latest: AppServerThreadTokenUsage;
}

export function codexTurnUsage(tokenUsage: CodexTurnTokenUsage): {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
} {
  return {
    input_tokens: tokenUsage.latest.total.inputTokens - tokenUsage.baseline.inputTokens,
    cached_input_tokens:
      tokenUsage.latest.total.cachedInputTokens - tokenUsage.baseline.cachedInputTokens,
    output_tokens: tokenUsage.latest.total.outputTokens - tokenUsage.baseline.outputTokens,
    reasoning_output_tokens:
      tokenUsage.latest.total.reasoningOutputTokens - tokenUsage.baseline.reasoningOutputTokens,
  };
}

export function codexContextUsagePayload(
  tokenUsage: CodexTurnTokenUsage | null | undefined,
): ContextUsagePayload | undefined {
  if (!tokenUsage) return undefined;
  const { last, modelContextWindow } = tokenUsage.latest;
  return makeContextUsagePayload(last.totalTokens, modelContextWindow, {
    estimated: last.inputTokens === 0 && last.outputTokens === 0,
  });
}

export function nowEpochSec(): number {
  return Date.now() / 1000;
}

export function timestampFromMs(ms: number | undefined): number {
  return typeof ms === "number" ? ms / 1000 : nowEpochSec();
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function fieldString(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const raw = value[key];
  return typeof raw === "string" ? raw : undefined;
}

export function jsonStringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return String(value);
  }
}

export function errorMessage(error: AppServerTurnError | null | undefined): string {
  return error?.message ?? "Codex app-server turn failed";
}

export function isTurnError(value: unknown): value is AppServerTurnError {
  return isRecord(value) && typeof value.message === "string";
}

export function rawContext(
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
