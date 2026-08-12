import type { ClaudeClientEvent } from "./claude_event_mapper.js";
import {
  asNumber,
  asRecord,
  asString,
} from "./claude_sdk_helpers.js";

const STRIPPED_HOOK_OUTPUT = "[stripped: persisted in tool_result]";
const GENERIC_HOOK_OUTPUT_FIELDS = new Set([
  "tool_response",
  "tool_responses",
  "tool_response_chunks",
]);

export function messageContent(message: Record<string, unknown>): unknown[] {
  const nested = asRecord(message.message);
  const content = nested?.content ?? message.content;
  if (Array.isArray(content)) return content;
  return [];
}

export function userMessageText(message: Record<string, unknown>): string | undefined {
  const nested = asRecord(message.message);
  const content = nested?.content ?? message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts = content
    .map((block) => asString(asRecord(block)?.text))
    .filter((text): text is string => Boolean(text));
  return parts.length > 0 ? parts.join("\n") : undefined;
}

export function extractBackgroundBashOutput(value: unknown): {
  taskId?: string;
  outputFile?: string;
} {
  const record = extractBackgroundBashOutputRecord(value);
  const taskId =
    asString(record?.backgroundTaskId) ??
    asString(record?.background_task_id);
  const outputFile =
    asString(record?.rawOutputPath) ??
    asString(record?.raw_output_path);
  return {
    ...(taskId ? { taskId } : {}),
    ...(outputFile ? { outputFile } : {}),
  };
}

export function stripGenericHookOutputFields(input: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (GENERIC_HOOK_OUTPUT_FIELDS.has(key)) {
      output[key] = STRIPPED_HOOK_OUTPUT;
    } else {
      output[key] = stripGenericHookOutputValue(value);
    }
  }
  return output;
}

export function permissionDenialsToStrings(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.map((item) => {
    const record = asRecord(item);
    const toolName = asString(record?.tool_name) ?? "tool";
    const toolUseId = asString(record?.tool_use_id);
    return toolUseId ? `${toolName}:${toolUseId}` : toolName;
  });
}

export function makeContextUsageEvent(
  usage: unknown,
  modelUsage: unknown,
  model: string | undefined,
): ClaudeClientEvent | undefined {
  const record = asRecord(usage);
  if (!record) return undefined;

  const inputTokens = asNumber(record.input_tokens) ?? asNumber(record.inputTokens) ?? 0;
  const outputTokens = asNumber(record.output_tokens) ?? asNumber(record.outputTokens) ?? 0;
  const cacheCreationTokens =
    asNumber(record.cache_creation_input_tokens)
    ?? asNumber(record.cacheCreationInputTokens)
    ?? sumNumericObject(record.cache_creation)
    ?? sumNumericObject(record.cacheCreation)
    ?? 0;
  const cacheReadTokens =
    asNumber(record.cache_read_input_tokens)
    ?? asNumber(record.cacheReadInputTokens)
    ?? 0;
  const usedTokens = inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens;
  if (usedTokens <= 0) return undefined;
  const maxTokens = resolveContextWindow(modelUsage, model);
  if (maxTokens === undefined) return undefined;

  return {
    type: "context_usage",
    usedTokens,
    maxTokens,
    percent: Math.round((usedTokens / maxTokens) * 1000) / 10,
  };
}

function resolveContextWindow(
  modelUsage: unknown,
  model: string | undefined,
): number | undefined {
  const records = asRecord(modelUsage);
  if (!records) return undefined;
  const candidates = Object.entries(records)
    .map(([key, value]) => {
      const record = asRecord(value);
      const contextWindow = asNumber(record?.contextWindow)
        ?? asNumber(record?.context_window);
      const canonicalModel = asString(record?.canonicalModel)
        ?? asString(record?.canonical_model);
      return { key, canonicalModel, contextWindow };
    })
    .filter((candidate) =>
      candidate.contextWindow !== undefined && candidate.contextWindow > 0,
    );
  if (model) {
    const exact = candidates.find((candidate) => candidate.key === model);
    if (exact?.contextWindow !== undefined) return exact.contextWindow;
    const canonical = candidates.find((candidate) => candidate.canonicalModel === model);
    if (canonical?.contextWindow !== undefined) return canonical.contextWindow;
  }
  const windows = new Set(candidates.map((candidate) => candidate.contextWindow));
  return windows.size === 1 ? candidates[0]?.contextWindow : undefined;
}

/**
 * rate_limit_info.resetsAt 값을 SSE wire용 ISO 문자열로 정규화.
 *
 * 수용 입력:
 *   - epoch seconds (≤ 1e12): Date 객체로 변환 후 ISO
 *   - epoch milliseconds (> 1e12): Date 객체로 변환 후 ISO
 *   - ISO 문자열: 그대로 passthrough
 *   - undefined / 그 외: undefined
 */
export function coerceResetsAt(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return epochNumberToIso(value);
  }
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  return undefined;
}

function extractBackgroundBashOutputRecord(
  value: unknown,
): Record<string, unknown> | undefined {
  const record = asRecord(value);
  if (record) {
    if (
      asString(record.backgroundTaskId) ||
      asString(record.background_task_id)
    ) {
      return record;
    }
    for (const key of ["content", "text", "tool_use_result"]) {
      const nested = extractBackgroundBashOutputRecord(record[key]);
      if (nested) return nested;
    }
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = extractBackgroundBashOutputRecord(item);
      if (nested) return nested;
    }
    return undefined;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
    try {
      return extractBackgroundBashOutputRecord(JSON.parse(trimmed));
    } catch {
      return undefined;
    }
  }

  return undefined;
}

function stripGenericHookOutputValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stripGenericHookOutputValue(item));
  }
  const record = asRecord(value);
  if (!record) return value;
  return stripGenericHookOutputFields(record);
}

function sumNumericObject(value: unknown): number | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  let total = 0;
  for (const item of Object.values(record)) {
    if (typeof item === "number" && Number.isFinite(item)) {
      total += item;
    }
  }
  return total > 0 ? total : undefined;
}

function epochNumberToIso(value: number | undefined): string | undefined {
  if (value === undefined) return undefined;
  const millis = value > 1_000_000_000_000 ? value : value * 1_000;
  return new Date(millis).toISOString();
}
