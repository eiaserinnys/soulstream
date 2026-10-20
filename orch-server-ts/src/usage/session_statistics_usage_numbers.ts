import type { NormalizedUsage } from "./session_statistics_fact_types.js";
import {
  addIssue,
  hasOwn,
  readNumeric,
} from "./session_statistics_normalization_helpers.js";
import type { UsageStatsProvider } from "@soulstream/wire-schema/session-statistics";

const BASE_INPUT_KEYS = ["input_tokens", "inputTokens"];
const CACHE_READ_KEYS = [
  "cached_input_tokens",
  "cache_read_input_tokens",
  "cacheReadInputTokens",
  "cache_read",
];
const CACHE_WRITE_KEYS = [
  "cache_creation_input_tokens",
  "cacheCreationInputTokens",
  "cache_write_input_tokens",
  "cacheWriteInputTokens",
  "cache_write",
];
const NATIVE_WRITE_KEYS = ["cache_creation_input_tokens", "cacheCreationInputTokens"];
const PARENT_CACHE_KEYS = [
  "cached_input_tokens",
  "cache_read",
  "cache_write_input_tokens",
  "cacheWriteInputTokens",
  "cache_write",
];
const LEGACY_READ_KEYS = ["cache_read_input_tokens", "cacheReadInputTokens"];

function composeInput(
  base: number | null,
  cacheRead: number | null,
  cacheWrite: number | null,
  issues: Set<string>,
): number | null {
  if (base === null || cacheRead === null || cacheWrite === null) return null;
  const sum = base + cacheRead + cacheWrite;
  if (!Number.isSafeInteger(sum)) {
    addIssue(issues, "normalization_error");
    return null;
  }
  return sum;
}

export function normalizeUsageNumbers(
  usage: Record<string, unknown>,
  provider: UsageStatsProvider,
  issues: Set<string>,
): NormalizedUsage {
  const outputTotal = readNumeric(usage, ["output_total", "output_tokens", "outputTokens"], issues);
  const reasoningOutput = readNumeric(usage, ["reasoning_output_tokens", "reasoningOutputTokens"], issues);
  const cacheRead = readNumeric(usage, CACHE_READ_KEYS, issues);
  const cacheWrite = readNumeric(usage, CACHE_WRITE_KEYS, issues);

  const hasExplicitInput = hasOwn(usage, "input_total");
  const hasNativeWrite = NATIVE_WRITE_KEYS.some((key) => hasOwn(usage, key));
  const hasParentCache = PARENT_CACHE_KEYS.some((key) => hasOwn(usage, key));
  const hasLegacyRead = LEGACY_READ_KEYS.some((key) => hasOwn(usage, key));
  const usesBaseInput = !hasExplicitInput && (hasNativeWrite || hasParentCache || !hasLegacyRead);
  const baseInput = usesBaseInput ? readNumeric(usage, BASE_INPUT_KEYS, issues) : null;

  let inputTotal: number | null;
  if (hasExplicitInput) {
    inputTotal = readNumeric(usage, ["input_total"], issues);
  } else if (hasNativeWrite) {
    inputTotal = composeInput(baseInput, cacheRead, cacheWrite, issues);
  } else if (hasParentCache) {
    inputTotal = baseInput;
  } else if (hasLegacyRead) {
    inputTotal = null;
  } else if (provider === "claude" || provider === "kimi") {
    inputTotal = composeInput(baseInput, cacheRead, cacheWrite, issues);
  } else {
    inputTotal = baseInput;
  }

  if (inputTotal !== null) {
    const cacheExceedsInput = (cacheRead !== null && cacheRead > inputTotal)
      || (cacheWrite !== null && cacheWrite > inputTotal)
      || (cacheRead !== null && cacheWrite !== null && cacheRead + cacheWrite > inputTotal);
    if (cacheExceedsInput) {
      addIssue(issues, "normalization_error");
      inputTotal = null;
    }
  }

  let totalTokens: number | null = null;
  if (inputTotal !== null && outputTotal !== null) {
    const sum = inputTotal + outputTotal;
    if (Number.isSafeInteger(sum)) {
      totalTokens = sum;
    } else {
      addIssue(issues, "normalization_error");
    }
  }

  return {
    input_total: inputTotal,
    output_total: outputTotal,
    total_tokens: totalTokens,
    cache_read: cacheRead,
    cache_write: cacheWrite,
    reasoning_output: reasoningOutput,
  };
}
