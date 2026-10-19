import type {
  UsageStatsInputMaterial,
  UsageStatsOptions,
  UsageStatsProvider,
} from "../../../wire-schema/src/session_statistics";
import { formatUsageStatsInputCategoryLabel } from "./usage-stats-format";

export type UsageStatsFilterKind = "all" | "provider" | "model";

export interface UsageStatsModelOption {
  id: string;
  label: string;
  provider: UsageStatsProvider | null;
  model: string | null;
}

export type UsageStatsInputMeasurement = UsageStatsInputMaterial["parts"][number]["measurement"] | "mixed";

export interface UsageStatsInputMaterialRow {
  category: string;
  label: string;
  approximate_tokens: number | null;
  share: number | null;
  measurement: UsageStatsInputMeasurement;
  partial: boolean;
}

interface CategoryTotal {
  category: string;
  approximate_tokens: number;
  has_known: boolean;
  has_missing: boolean;
  has_reported: boolean;
  has_calibrated: boolean;
  has_estimate: boolean;
}

const INPUT_CATEGORY_ORDER = [
  "system_prompt",
  "soulstream_injection",
  "user_prompt",
  "tool_result",
  "history_replay",
  "tool_definition",
  "framing",
  "combined_visible",
  "unknown",
  "harness_internal",
];

export function usageStatsFilterKey(kind: UsageStatsFilterKind, provider: string | null, model: string | null): string {
  return JSON.stringify([kind, provider, model]);
}

export function buildUsageStatsModelOptions(options: UsageStatsOptions): UsageStatsModelOption[] {
  const result: UsageStatsModelOption[] = [{
    id: usageStatsFilterKey("all", null, null),
    label: "전체",
    provider: null,
    model: null,
  }];
  for (const provider of options.providers) {
    result.push({
      id: usageStatsFilterKey("provider", provider.provider, null),
      label: provider.label,
      provider: provider.provider,
      model: null,
    });
  }
  for (const provider of options.providers) {
    for (const model of options.models) {
      if (model.provider !== provider.provider || model.model === null) continue;
      const id = usageStatsFilterKey("model", model.provider, model.model);
      let exists = false;
      for (const option of result) if (option.id === id) exists = true;
      if (exists) continue;
      result.push({
        id,
        label: `${provider.label} · ${model.label}`,
        provider: model.provider,
        model: model.model,
      });
    }
  }
  return result;
}

export function usageStatsSeriesKey(provider: string, model: string | null, modelMode: boolean): string {
  if (modelMode) return JSON.stringify(["model", provider, model]);
  return JSON.stringify(["provider", provider]);
}

// This creates display rows only; source parts, their keys, and the DTO denominator stay untouched.
export function groupUsageStatsInputMaterial(material: UsageStatsInputMaterial): UsageStatsInputMaterialRow[] {
  const totals: CategoryTotal[] = [];
  let hasHarness = false;
  for (const part of material.parts) {
    if (part.category === "harness_internal") {
      hasHarness = true;
      continue;
    }
    let category = part.category;
    let knownCategory = false;
    for (const fixedCategory of INPUT_CATEGORY_ORDER) if (fixedCategory === category) knownCategory = true;
    if (!knownCategory) category = "unknown";
    let total: CategoryTotal | undefined;
    for (const candidate of totals) if (candidate.category === category) total = candidate;
    if (!total) {
      total = {
        category,
        approximate_tokens: 0,
        has_known: false,
        has_missing: false,
        has_reported: false,
        has_calibrated: false,
        has_estimate: false,
      };
      totals.push(total);
    }
    if (part.approximate_tokens === null) {
      total.has_missing = true;
      continue;
    }
    total.approximate_tokens += part.approximate_tokens;
    total.has_known = true;
    if (part.measurement === "reported") total.has_reported = true;
    else if (part.measurement === "calibrated_estimate") total.has_calibrated = true;
    else if (part.measurement === "estimate") total.has_estimate = true;
  }

  const rows: UsageStatsInputMaterialRow[] = [];
  for (const category of INPUT_CATEGORY_ORDER) {
    let total: CategoryTotal | undefined;
    for (const candidate of totals) if (candidate.category === category) total = candidate;
    if (!total) continue;
    let measurement: UsageStatsInputMeasurement = "unobserved";
    if (total.has_known) {
      if (total.has_estimate) measurement = "estimate";
      else if (total.has_calibrated) measurement = "calibrated_estimate";
      else if (total.has_reported) measurement = "reported";
      else measurement = "mixed";
    }
    const partial = total.has_known && total.has_missing;
    const share = total.has_known && !(total.approximate_tokens === 0 && total.has_missing) &&
      material.observed_approximate_tokens !== null && material.observed_approximate_tokens > 0
      ? total.approximate_tokens / material.observed_approximate_tokens
      : null;
    rows.push({
      category,
      label: formatUsageStatsInputCategoryLabel(category),
      approximate_tokens: total.has_known ? total.approximate_tokens : null,
      share,
      measurement,
      partial,
    });
  }
  if (hasHarness) {
    rows.push({
      category: "harness_internal",
      label: formatUsageStatsInputCategoryLabel("harness_internal"),
      approximate_tokens: null,
      share: null,
      measurement: "unobserved",
      partial: false,
    });
  }
  return rows;
}
