import { estimateInputTokens } from "@soulstream/model-catalog/input-token-estimate";
import type {
  EventIdentity,
  FactDraft,
  SessionStatisticsEventInput,
} from "./session_statistics_fact_types.js";
import {
  addIssue,
  blankFact,
  compareText,
  hasOwn,
  isRecord,
  knownInteger,
  parseIdentity,
  stringOrNull,
} from "./session_statistics_normalization_helpers.js";
import { normalizeUsageEvent } from "./session_statistics_usage_candidates.js";

export { CANONICAL_USAGE_PRIORITY, selectCanonicalInputMaterialFacts, selectCanonicalUsageCandidates } from "./session_statistics_canonical.js";
export type { CanonicalUsageSelection, FactDraft, SessionStatisticsEventInput, UsageCandidateType } from "./session_statistics_fact_types.js";

function materialRow(
  event: SessionStatisticsEventInput,
  identity: EventIdentity,
  partKey: string,
  values: {
    category?: string | null;
    sourceKey?: string | null;
    estimateSource?: "manifest" | "derived_chars" | null;
    rawChars?: number | null;
    approximateTokens?: number | null;
  },
  quality: readonly string[] = [],
): FactDraft {
  return {
    ...blankFact(event, identity, partKey, "input_material", quality),
    category: values.category ?? null,
    source_key: values.sourceKey ?? null,
    estimate_source: values.estimateSource ?? null,
    raw_chars_utf16: values.rawChars ?? null,
    approximate_tokens: values.approximateTokens ?? null,
  };
}

function boundaryRow(
  event: SessionStatisticsEventInput,
  identity: EventIdentity,
  boundaryType: NonNullable<FactDraft["boundary_type"]>,
  quality: readonly string[] = [],
): FactDraft {
  return {
    ...blankFact(event, identity, `boundary/${boundaryType}`, "boundary", quality),
    boundary_type: boundaryType,
  };
}

function parseManifestPart(
  event: SessionStatisticsEventInput,
  identity: EventIdentity,
  value: unknown,
  index: number,
  issues: Set<string>,
): FactDraft {
  const localIssues = new Set<string>();
  if (!isRecord(value)) {
    addIssue(issues, "normalization_error");
    return materialRow(event, identity, `material/${index}`, {}, ["normalization_error"]);
  }
  const category = stringOrNull(value.category);
  const sourceKey = stringOrNull(value.source_key);
  const rawChars = hasOwn(value, "raw_chars_utf16") ? knownInteger(value.raw_chars_utf16) : null;
  const storedEstimate = hasOwn(value, "approximate_tokens") ? knownInteger(value.approximate_tokens) : null;
  const sourceValue = value.estimate_source;
  const estimateSource = sourceValue === "manifest" || sourceValue === "derived_chars"
    ? sourceValue
    : null;
  if ((value.category !== undefined && category === null)
    || (value.source_key !== undefined && value.source_key !== null && sourceKey === null)
    || (hasOwn(value, "raw_chars_utf16") && rawChars === null)
    || (hasOwn(value, "approximate_tokens") && storedEstimate === null)
    || (sourceValue !== undefined && sourceValue !== null && estimateSource === null)) {
    localIssues.add("normalization_error");
  }
  const approximateTokens = estimateInputTokens({
    storedTokenEstimate: storedEstimate,
    charsUtf16: rawChars,
  });
  const finalEstimateSource = storedEstimate !== null
    ? estimateSource ?? "manifest"
    : rawChars !== null && approximateTokens !== null ? "derived_chars" : estimateSource;
  for (const issue of localIssues) addIssue(issues, issue);
  return materialRow(event, identity, `material/${index}`, {
    category,
    sourceKey,
    estimateSource: finalEstimateSource,
    rawChars,
    approximateTokens,
  }, [...localIssues]);
}

function normalizeInputManifest(
  event: SessionStatisticsEventInput,
  payload: Record<string, unknown> | null,
  identity: EventIdentity,
  issues: Set<string>,
): FactDraft[] {
  const facts: FactDraft[] = [boundaryRow(event, identity, "command_started")];
  const executionInput = isRecord(payload?.execution_input) ? payload.execution_input : null;
  if (!payload || !executionInput || !hasOwn(executionInput, "parts")) {
    addIssue(issues, "normalization_error");
    facts[0]!.quality = [...new Set([
      ...facts[0]!.quality,
      "normalization_error",
      "material_breakdown_unavailable",
    ])].sort(compareText);
    return facts;
  }
  const parts = executionInput.parts;
  if (parts === null) {
    facts[0]!.quality = [...facts[0]!.quality, "material_breakdown_unavailable"];
    return facts;
  }
  if (!Array.isArray(parts)) {
    addIssue(issues, "normalization_error");
    facts[0]!.quality = [...new Set([
      ...facts[0]!.quality,
      "normalization_error",
      "material_breakdown_unavailable",
    ])].sort(compareText);
    return facts;
  }
  parts.forEach((part, index) => {
    facts.push(parseManifestPart(event, identity, part, index, issues));
  });
  return facts;
}

function normalizeLegacyContextManifest(
  event: SessionStatisticsEventInput,
  payload: Record<string, unknown> | null,
  identity: EventIdentity,
  issues: Set<string>,
): FactDraft[] {
  const sources = payload?.sources;
  if (!payload || !Array.isArray(sources)) {
    addIssue(issues, "normalization_error");
    const quality = identity.inputId === null
      ? ["normalization_error", "unmatched_legacy_material"]
      : ["normalization_error"];
    return [materialRow(event, identity, "material/0", {}, quality)];
  }
  return sources.map((source, index) => {
    if (!isRecord(source)) {
      addIssue(issues, "normalization_error");
      return materialRow(event, identity, `material/${index}`, {}, ["normalization_error", "unmatched_legacy_material"]);
    }
    const localIssues = new Set<string>();
    const chars = knownInteger(source.chars);
    const stored = knownInteger(source.token_estimate);
    if (chars === null && hasOwn(source, "chars")) localIssues.add("normalization_error");
    if (stored === null && hasOwn(source, "token_estimate")) localIssues.add("normalization_error");
    const approximateTokens = estimateInputTokens({ storedTokenEstimate: stored, charsUtf16: chars });
    const rawId = stringOrNull(source.id);
    const instance = stringOrNull(source.instance);
    const sourceKey = rawId !== null && instance !== null ? `context/${instance}/${rawId}` : null;
    if (source.id !== undefined && rawId === null) localIssues.add("normalization_error");
    if (source.instance !== undefined && instance === null) localIssues.add("normalization_error");
    for (const issue of localIssues) addIssue(issues, issue);
    const quality = [...localIssues];
    if (identity.inputId === null) quality.push("unmatched_legacy_material");
    return materialRow(event, identity, `material/${index}`, {
      category: "soulstream_injection",
      sourceKey,
      estimateSource: stored !== null ? "manifest" : chars !== null && approximateTokens !== null ? "derived_chars" : null,
      rawChars: chars,
      approximateTokens,
    }, quality);
  });
}

function normalizeMessageMaterial(
  event: SessionStatisticsEventInput,
  payload: Record<string, unknown> | null,
  identity: EventIdentity,
  category: "user_prompt" | "system_prompt",
  issues: Set<string>,
): FactDraft[] {
  const facts: FactDraft[] = [];
  if (event.eventType === "user_message") facts.push(boundaryRow(event, identity, "input"));
  const text = payload?.text;
  const sourceQuality = event.eventType === "system_message" && identity.inputId === null
    ? ["unmatched_legacy_material"]
    : [];
  if (typeof text === "string") {
    const estimate = estimateInputTokens({ charsUtf16: text.length });
    facts.push(materialRow(event, identity, "material/0", {
      category,
      sourceKey: identity.inputId === null ? `event/${String(event.eventId)}/${category}` : `input/${identity.inputId}/${category}`,
      estimateSource: "derived_chars",
      rawChars: text.length,
      approximateTokens: estimate,
    }, sourceQuality));
  } else if (text !== undefined && text !== null) {
    addIssue(issues, "normalization_error");
    facts.push(materialRow(event, identity, "material/0", { category }, [...sourceQuality, "normalization_error"]));
  }
  return facts;
}

function normalizeToolEvent(
  event: SessionStatisticsEventInput,
  payload: Record<string, unknown> | null,
  identity: EventIdentity,
  issues: Set<string>,
): FactDraft[] {
  if (event.eventType === "tool_start") {
    const fact = blankFact(event, identity, "tool_call", "tool_call");
    fact.source_key = stringOrNull(payload?.tool_use_id);
    if (!payload) {
      fact.quality = [...new Set([...fact.quality, "normalization_error"])].sort(compareText);
      addIssue(issues, "normalization_error");
    }
    return [fact];
  }
  const result = payload?.result;
  if (typeof result === "string") {
    return [materialRow(event, identity, "material/0", {
      category: "tool_result",
      sourceKey: stringOrNull(payload?.tool_use_id),
      estimateSource: "derived_chars",
      rawChars: result.length,
      approximateTokens: estimateInputTokens({ charsUtf16: result.length }),
    })];
  }
  const quality = result === undefined || result === null
    ? ["unsupported_source_shape"]
    : ["unsupported_source_shape"];
  addIssue(issues, "unsupported_source_shape");
  return [materialRow(event, identity, "material/0", {
    category: "tool_result",
    sourceKey: stringOrNull(payload?.tool_use_id),
  }, quality)];
}

export function normalizeSessionStatisticsEvent(
  event: SessionStatisticsEventInput,
): { facts: FactDraft[]; issues: string[] } {
  const issues = new Set<string>();
  const payload = isRecord(event.payload) ? event.payload : null;
  const identity = parseIdentity(payload, event.eventType, issues);
  if (!payload && [
    "complete", "result", "error", "usage_observation", "input_material_manifest",
    "context_manifest", "user_message", "system_message", "tool_start", "tool_result",
  ].includes(event.eventType)) {
    identity.quality = [...new Set([...identity.quality, "normalization_error"])].sort(compareText);
    addIssue(issues, "normalization_error");
  }
  let facts: FactDraft[];

  if (["complete", "result", "error", "usage_observation"].includes(event.eventType)) {
    facts = normalizeUsageEvent(event, payload, identity, issues);
  } else if (event.eventType === "input_material_manifest") {
    facts = normalizeInputManifest(event, payload, identity, issues);
  } else if (event.eventType === "context_manifest") {
    facts = normalizeLegacyContextManifest(event, payload, identity, issues);
  } else if (event.eventType === "user_message" || event.eventType === "system_message") {
    facts = normalizeMessageMaterial(
      event,
      payload,
      identity,
      event.eventType === "user_message" ? "user_prompt" : "system_prompt",
      issues,
    );
    if (!payload) {
      addIssue(issues, "normalization_error");
      for (const fact of facts) {
        fact.quality = [...new Set([...fact.quality, "normalization_error"])].sort(compareText);
      }
    }
  } else if (event.eventType === "tool_start" || event.eventType === "tool_result") {
    facts = normalizeToolEvent(event, payload, identity, issues);
  } else if (event.eventType === "session_ended") {
    facts = [boundaryRow(event, identity, "session_ended", payload ? [] : ["normalization_error"])];
    if (!payload) addIssue(issues, "normalization_error");
  } else {
    facts = [];
  }
  return { facts, issues: [...issues].sort(compareText) };
}
