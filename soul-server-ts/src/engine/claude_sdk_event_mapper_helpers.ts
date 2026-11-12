import type { ClaudeClientEvent } from "./claude_client_event.js";
import { contextUsagePercent } from "./context_usage.js";
import {
  asArray,
  asNullableString,
  asNumber,
  asRecord,
  asString,
  asStringArray,
  firstString,
} from "./claude_sdk_helpers.js";
import { isRecoverableExecutionDiagnostic, resultErrorCode } from "./claude_sdk_diagnostics.js";
import { attachClaudeResultInputReceipt } from "./claude_sdk_event_metadata.js";
import { claudeTurnCostUsd } from "./list_price.js";
import { readTranscriptTurnIterationUsage } from "./claude_sdk_transcript_usage.js";
import type { ModelCatalogConfig } from "../model_catalog.js";

const STRIPPED_HOOK_OUTPUT = "[stripped: persisted in tool_result]";
const GENERIC_HOOK_OUTPUT_FIELDS = new Set([
  "tool_response",
  "tool_responses",
  "tool_response_chunks",
]);
/** OpenCode Go와 호환 엔드포인트는 modelUsage에 contextWindow를 주지 않는다. */
const DEEPSEEK_COMPATIBLE_CONTEXT_WINDOW = 262_144;

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

export function lastIterationUsage(usage: unknown): Record<string, unknown> | undefined {
  const iterations = asRecord(usage)?.iterations;
  if (!Array.isArray(iterations)) return undefined;

  for (let index = iterations.length - 1; index >= 0; index -= 1) {
    const iteration = asRecord(iterations[index]);
    if (iteration && (iteration.type === undefined || iteration.type === "message")) {
      return iteration;
    }
  }
  return undefined;
}

/**
 * Tool-only assistant messages can be reported with all-zero usage by
 * Anthropic-compatible endpoints. Those must not become the turn's first call
 * or the latest context measurement.
 */
export function hasPositiveIterationUsage(usage: unknown): boolean {
  const record = asRecord(usage);
  if (!record) return false;
  const total =
    (asNumber(record.input_tokens) ?? 0) +
    (asNumber(record.output_tokens) ?? 0) +
    (asNumber(record.cache_read_input_tokens) ?? 0) +
    (asNumber(record.cache_creation_input_tokens) ?? 0);
  return total > 0;
}

export function firstCallInput(usage: unknown): {
  inputTokens: number;
  cachedInputTokens: number;
} | undefined {
  const record = asRecord(usage);
  if (!record) return undefined;

  const cachedInputTokens = asNumber(record.cache_read_input_tokens) ?? 0;
  const inputTokens =
    (asNumber(record.input_tokens) ?? 0) +
    cachedInputTokens +
    (asNumber(record.cache_creation_input_tokens) ?? 0);
  if (!Number.isFinite(inputTokens) || inputTokens <= 0) return undefined;

  return { inputTokens, cachedInputTokens };
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
  const maxTokens = resolveContextWindow(modelUsage, model);
  if (maxTokens === undefined) return undefined;
  const percent = contextUsagePercent(usedTokens, maxTokens);
  if (percent === undefined) return undefined;

  return {
    type: "context_usage",
    usedTokens,
    maxTokens,
    percent,
  };
}

function resolveContextWindow(
  modelUsage: unknown,
  model: string | undefined,
): number | undefined {
  const records = asRecord(modelUsage);
  const candidates = Object.entries(records ?? {})
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
  const declared = windows.size === 1 ? candidates[0]?.contextWindow : undefined;
  if (declared !== undefined) return declared;
  return resolveCompatibleModelContextWindow(model, records);
}

function resolveCompatibleModelContextWindow(
  model: string | undefined,
  records: Record<string, unknown> | undefined,
): number | undefined {
  const modelIds = [
    ...(model === undefined ? [] : [model]),
    ...(records === undefined ? [] : Object.keys(records)),
  ];
  return modelIds.some(isDeepSeekCompatibleModelId)
    ? DEEPSEEK_COMPATIBLE_CONTEXT_WINDOW
    : undefined;
}

function isDeepSeekCompatibleModelId(modelId: string): boolean {
  const normalized = modelId.trim().toLowerCase();
  return normalized.startsWith("deepseek-")
    || normalized.startsWith("opencode/deepseek-")
    || normalized === "kimi-for-coding"
    || normalized === "k3";
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

export interface ResultIterationUsage {
  firstIterationUsage: unknown;
  latestIterationUsage: unknown;
  resultLastIterationUsage: Record<string, unknown> | undefined;
}

/**
 * Chooses the iteration usage for this turn: live stream values when they are
 * positive, otherwise transcript usage anchored to the turn's assistant UUIDs.
 *
 * Zero-token result iterations are the same hole as zero-token assistant
 * messages: they must not become the turn's context measurement.
 */
export function resolveResultIterationUsage(input: {
  transcriptPath: string | undefined;
  turnFirstAssistantUuid: string | undefined;
  turnLastAssistantUuid: string | undefined;
  resultUsage: unknown;
  firstIterationUsage: unknown;
  latestIterationUsage: unknown;
}): ResultIterationUsage {
  const lastResultUsage = lastIterationUsage(input.resultUsage);
  const resultLastIterationUsage = hasPositiveIterationUsage(lastResultUsage)
    ? lastResultUsage
    : undefined;
  let firstIterationUsage = input.firstIterationUsage;
  let latestIterationUsage = input.latestIterationUsage;
  if (
    input.transcriptPath !== undefined
    && (
      firstCallInput(firstIterationUsage) === undefined
      || (resultLastIterationUsage === undefined && latestIterationUsage === undefined)
    )
  ) {
    const recovered = readTranscriptTurnIterationUsage(
      input.transcriptPath,
      input.turnFirstAssistantUuid,
      input.turnLastAssistantUuid,
    );
    if (recovered !== undefined) {
      if (firstCallInput(firstIterationUsage) === undefined && recovered.first !== undefined) {
        firstIterationUsage = recovered.first;
      }
      if (latestIterationUsage === undefined && recovered.last !== undefined) {
        latestIterationUsage = recovered.last;
      }
    }
  }
  return { firstIterationUsage, latestIterationUsage, resultLastIterationUsage };
}

export interface ClaudeResultMessageMapperContext {
  latestIterationModel: string | undefined;
  firstIterationUsage: unknown;
  latestIterationUsage: unknown;
  transcriptPath: string | undefined;
  turnFirstAssistantUuid: string | undefined;
  turnLastAssistantUuid: string | undefined;
  /** Catalogue snapshot captured once for this terminal message. */
  catalog?: ModelCatalogConfig;
  withSdkMessageDedupe(
    events: ClaudeClientEvent[],
    message: Record<string, unknown>,
  ): ClaudeClientEvent[];
}

export function mapClaudeResultMessage(
  message: Record<string, unknown>,
  context: ClaudeResultMessageMapperContext,
): ClaudeClientEvent[] {
  const success = message.subtype === "success" && message.is_error !== true;
  const output = success
    ? asString(message.result) ?? ""
    : firstString(asArray(message.errors)) ??
      asString(message.result) ??
      asString(message.subtype) ??
      "";
  const usage = message.usage;
  const totalCostUsd = asNumber(message.total_cost_usd);
  const stopReason = asNullableString(message.stop_reason);
  const terminalReason = asNullableString(message.terminal_reason);
  const modelUsage = asRecord(message.modelUsage);
  const model = context.latestIterationModel;
  const turnCostUsd = context.catalog
    ? claudeTurnCostUsd(context.catalog, usage, model)
    : undefined;
  const iterationUsage = resolveResultIterationUsage({
    transcriptPath: context.transcriptPath,
    turnFirstAssistantUuid: context.turnFirstAssistantUuid,
    turnLastAssistantUuid: context.turnLastAssistantUuid,
    resultUsage: message.usage,
    firstIterationUsage: context.firstIterationUsage,
    latestIterationUsage: context.latestIterationUsage,
  });
  const firstCall = firstCallInput(iterationUsage.firstIterationUsage);
  const resultEvent: ClaudeClientEvent = {
    type: "result",
    success,
    output,
    error: success ? null : output,
    ...(usage !== undefined ? { usage } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(turnCostUsd !== undefined ? { turnCostUsd } : {}),
    ...(firstCall !== undefined ? { firstCall } : {}),
    totalCostUsd: totalCostUsd ?? null,
    ...(stopReason !== undefined ? { stopReason } : {}),
    ...(terminalReason !== undefined ? { terminalReason } : {}),
    errors: asStringArray(message.errors),
    ...(modelUsage !== undefined ? { modelUsage } : {}),
    permissionDenials: permissionDenialsToStrings(message.permission_denials),
  };
  const contextUsageEvent = makeContextUsageEvent(
    iterationUsage.resultLastIterationUsage ?? iterationUsage.latestIterationUsage,
    message.modelUsage,
    context.latestIterationModel,
  );

  if (!success) {
    const errorEvent: ClaudeClientEvent = {
      type: "error",
      message: output || "Claude SDK result indicated failure",
      fatal: !isRecoverableExecutionDiagnostic(message),
      errorCode: resultErrorCode(message),
    };
    const events = context.withSdkMessageDedupe([
      resultEvent,
      ...(contextUsageEvent ? [contextUsageEvent] : []),
      errorEvent,
    ], message);
    attachClaudeResultInputReceipt(events, message);
    return events;
  }

  const claudeSessionId = asString(message.session_id);
  const completeEvent: ClaudeClientEvent = {
    type: "complete",
    result: output,
    ...(claudeSessionId !== undefined ? { claudeSessionId } : {}),
    ...(usage !== undefined ? { usage } : {}),
    ...(totalCostUsd !== undefined ? { totalCostUsd } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(turnCostUsd !== undefined ? { turnCostUsd } : {}),
    ...(firstCall !== undefined ? { firstCall } : {}),
  };
  const events = context.withSdkMessageDedupe([
    resultEvent,
    ...(contextUsageEvent ? [contextUsageEvent] : []),
    completeEvent,
  ], message);
  attachClaudeResultInputReceipt(events, message);
  return events;
}
