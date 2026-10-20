import { priceInferenceUsage } from "@soulstream/model-catalog/inference-pricing";
import type {
  EventIdentity,
  FactDraft,
  SessionStatisticsEventInput,
  UsageCandidateType,
  NormalizedUsage,
} from "./session_statistics_fact_types.js";
import {
  addIssue,
  compareText,
  hasOwn,
  isRecord,
  numericFields,
  blankFact,
} from "./session_statistics_normalization_helpers.js";
import type { UsageStatsProvider } from "@soulstream/wire-schema/session-statistics";
import { normalizeUsageNumbers } from "./session_statistics_usage_numbers.js";

const AGGREGATE_USAGE_KEYS = [
  "input_tokens", "inputTokens", "input_total", "output_tokens", "outputTokens", "output_total",
  "cache_read_input_tokens", "cacheReadInputTokens", "cached_input_tokens", "cache_read",
  "cache_creation_input_tokens", "cacheCreationInputTokens", "cache_write_input_tokens",
  "cacheWriteInputTokens", "cache_write", "reasoning_output_tokens", "reasoningOutputTokens",
];
const MODEL_USAGE_KEYS = [
  "inputTokens", "input_tokens", "outputTokens", "output_tokens", "cacheCreationInputTokens",
  "cache_creation_input_tokens", "cacheReadInputTokens", "cache_read_input_tokens",
  "cache_write_input_tokens", "reasoningOutputTokens", "reasoning_output_tokens",
];
const FIRST_CALL_KEYS = ["input_tokens", "cached_input_tokens", "inputTokens", "cachedInputTokens"];
const RAW_OPENCODE_KEYS = ["input", "output", "reasoning", "cache_read", "cache_write", "total"];

function safeRawNumeric(
  payload: Record<string, unknown> | null,
  issues: Set<string>,
  modelKey?: string,
): Record<string, unknown> | null {
  if (!payload) return null;
  const output: Record<string, unknown> = {};
  if (isRecord(payload.usage)) output.usage = numericFields(payload.usage, AGGREGATE_USAGE_KEYS, issues);
  if (isRecord(payload.first_call)) output.first_call = numericFields(payload.first_call, FIRST_CALL_KEYS, issues);
  if (isRecord(payload.raw_usage)) output.raw_usage = numericFields(payload.raw_usage, RAW_OPENCODE_KEYS, issues);
  if (modelKey !== undefined && isRecord(payload.model_usage) && isRecord(payload.model_usage[modelKey])) {
    output.model_usage = Object.fromEntries([
      [modelKey, numericFields(payload.model_usage[modelKey] as Record<string, unknown>, MODEL_USAGE_KEYS, issues)],
    ]);
  } else if (isRecord(payload.model_usage)) {
    const entries = Object.entries(payload.model_usage).sort(([left], [right]) => compareText(left, right));
    output.model_usage = Object.fromEntries(entries.map(([key, value]) => [
      key,
      isRecord(value) ? numericFields(value, MODEL_USAGE_KEYS, issues) : {},
    ]));
  }
  return Object.keys(output).length > 0 ? output : null;
}

export function priceNormalizedUsage(
  usage: NormalizedUsage,
  provider: UsageStatsProvider,
  model: string | null,
) {
  const writeKnown = usage.cache_write !== null;
  const priced = priceInferenceUsage({
    provider,
    model,
    input_total: usage.input_total,
    cache_read: usage.cache_read,
    cache_write_5m: writeKnown ? 0 : null,
    cache_write_1h: writeKnown ? 0 : null,
    cache_write_unknown: usage.cache_write,
    output_total: usage.output_total,
  });
  return {
    known_cost_usd: priced.known_cost_usd,
    priced_tokens: priced.priced_tokens,
    unpriced_tokens: priced.unpriced_tokens,
    pricing_complete: priced.pricing_complete,
    pricing_version: priced.price_version,
  };
}

function usageRow(
  event: SessionStatisticsEventInput,
  identity: EventIdentity,
  payload: Record<string, unknown> | null,
  candidateType: UsageCandidateType,
  partKey: string,
  representation: FactDraft["representation"],
  rawUsage: Record<string, unknown> | null,
  model: string | null,
  issues: Set<string>,
): FactDraft {
  const rowQuality = new Set(identity.quality);
  const usageIsDiagnostic = representation === "diagnostic";
  let normalized: NormalizedUsage = {
    input_total: null,
    output_total: null,
    total_tokens: null,
    cache_read: null,
    cache_write: null,
    reasoning_output: null,
  };
  if (rawUsage) {
    const usageIssues = new Set<string>();
    normalized = normalizeUsageNumbers(rawUsage, identity.provider, usageIssues);
    for (const issue of usageIssues) {
      rowQuality.add(issue);
      addIssue(issues, issue);
    }
  }
  if (payload && payload.usage !== undefined && payload.usage !== null && !isRecord(payload.usage)) {
    rowQuality.add("normalization_error");
    addIssue(issues, "normalization_error");
  }
  if (usageIsDiagnostic) {
    normalized = {
      input_total: null,
      output_total: null,
      total_tokens: null,
      cache_read: null,
      cache_write: null,
      reasoning_output: null,
    };
  }
  const rawIssues = new Set<string>();
  const rawNumeric = safeRawNumeric(
    payload,
    rawIssues,
    partKey.startsWith("usage:model/") ? model ?? undefined : undefined,
  );
  for (const issue of rawIssues) {
    rowQuality.add(issue);
    addIssue(issues, issue);
  }
  const base = blankFact(event, identity, partKey, "usage", [...rowQuality]);
  const price = usageIsDiagnostic ? {
    known_cost_usd: null,
    priced_tokens: null,
    unpriced_tokens: null,
    pricing_complete: null,
    pricing_version: null,
  } : priceNormalizedUsage(normalized, identity.provider, model);
  return {
    ...base,
    model,
    candidate_type: candidateType,
    representation,
    ...normalized,
    ...price,
    raw_numeric: rawNumeric,
  };
}

function candidateTypeForEvent(
  eventType: string,
  payload: Record<string, unknown> | null,
  issues: Set<string>,
): UsageCandidateType {
  if (eventType === "complete") return "complete";
  if (eventType === "result") {
    if (payload?.success === true) return "success_result";
    if (payload?.success === false) return "failed_result";
    addIssue(issues, "normalization_error");
    return "diagnostic";
  }
  if (eventType === "error") {
    if (payload && isRecord(payload.usage)) return "failed_error";
    if (payload?.fatal === true) return "failed_error";
    return "diagnostic";
  }
  if (eventType === "usage_observation") {
    return payload?.outcome === "interrupted" && payload.source === "opencode_step_finish"
      ? "interrupt_observation"
      : "diagnostic";
  }
  return "diagnostic";
}

function encodeModelKey(modelKey: string): string | null {
  try {
    return `usage:model/${encodeURIComponent(modelKey)}`;
  } catch {
    return null;
  }
}

export function normalizeUsageEvent(
  event: SessionStatisticsEventInput,
  payload: Record<string, unknown> | null,
  identity: EventIdentity,
  issues: Set<string>,
): FactDraft[] {
  const candidateType = candidateTypeForEvent(event.eventType, payload, issues);
  const usageValue = payload?.usage;
  const rawUsage = isRecord(usageValue) ? usageValue : null;
  const representation = candidateType === "success_result" || candidateType === "diagnostic"
    ? "diagnostic"
    : "aggregate";
  const facts = [usageRow(
    event,
    identity,
    payload,
    candidateType,
    representation === "diagnostic" ? "usage:diagnostic" : "usage:aggregate",
    representation,
    rawUsage,
    identity.model,
    issues,
  )];

  if (payload && hasOwn(payload, "model_usage") && payload.model_usage !== null) {
    if (!isRecord(payload.model_usage)) {
      addIssue(issues, "normalization_error");
      facts[0]!.quality = [...new Set([
        ...facts[0]!.quality,
        "model_breakdown_unverified",
        "normalization_error",
      ])].sort(compareText);
      return facts;
    }
    const modelEntries = Object.entries(payload.model_usage).sort(([left], [right]) => compareText(left, right));
    for (const [modelKey, value] of modelEntries) {
      const partKey = encodeModelKey(modelKey);
      if (partKey === null) {
        addIssue(issues, "normalization_error");
        facts[0]!.quality = [...new Set([...facts[0]!.quality, "normalization_error"])].sort(compareText);
        continue;
      }
      const modelUsage = isRecord(value) ? value : null;
      const modelIssues = new Set<string>();
      const row = usageRow(
        event,
        identity,
        payload,
        candidateType,
        partKey,
        modelUsage && representation !== "diagnostic" ? "model_breakdown" : "diagnostic",
        modelUsage,
        modelKey,
        modelIssues,
      );
      if (!modelUsage) {
        row.quality = [...new Set([...row.quality, "normalization_error"])].sort(compareText);
        addIssue(issues, "normalization_error");
      }
      for (const issue of modelIssues) addIssue(issues, issue);
      facts.push(row);
    }
  }
  return facts;
}
