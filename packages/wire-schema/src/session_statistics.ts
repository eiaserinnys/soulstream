export type UsageStatsPeriod = "week" | "month" | "all";
export type UsageStatsProvider =
  | "claude"
  | "codex"
  | "antigravity"
  | "deepseek"
  | "kimi"
  | "unknown";

export const USAGE_STATS_PROVIDERS: UsageStatsProvider[] = [
  "claude",
  "codex",
  "antigravity",
  "deepseek",
  "kimi",
  "unknown",
];

export const USAGE_STATS_UNKNOWN_PROVIDER_LABEL = "공급자 미확인";

export interface UsageStatsQuery {
  period: UsageStatsPeriod;
  anchor: string;
  provider?: UsageStatsProvider | null;
  model?: string | null;
  project_ids?: readonly string[];
}

export interface UsageStatsCostComponent {
  known_cost_usd: number | null;
  is_partial: boolean;
}

export interface UsageStatsTokenPartials {
  total_tokens: boolean;
  provider_total_tokens: boolean;
  ordinary_input: boolean;
  cache_read: boolean;
}

export interface UsageStatsMetrics {
  input_total: number | null;
  cache_read: number | null;
  cache_write: number | null;
  output_total: number | null;
  reasoning_output: number | null;
  total_tokens: number | null;
  provider_total_tokens: number | null;
  ordinary_input: number | null;
  reference_cost_usd: number | null;
  reference_cost_breakdown: {
    cache_read: UsageStatsCostComponent;
    non_cache: UsageStatsCostComponent;
  };
}

export interface UsageStatsCoverage {
  usage_complete_events: number;
  usage_partial_events: number;
  terminal_missing_usage: number;
  ended_input_without_usage: number;
  missing_usage_turns: number;
  pending_inputs: number;
  priced_events: number;
  unpriced_events: number;
  priced_total_tokens: number | null;
  unpriced_total_tokens: number | null;
  unknown_total_token_events: number;
  unattributed_missing_usage: boolean;
  token_partials: UsageStatsTokenPartials;
}

export interface UsageStatsAggregate {
  metrics: UsageStatsMetrics;
  coverage: UsageStatsCoverage;
  is_partial: boolean;
}

export interface UsageStatsProviderRow extends UsageStatsAggregate {
  provider: UsageStatsProvider;
  backend: string;
  model: string | null;
  attribution: "provider" | "model";
}

export interface UsageStatsProjectRow extends UsageStatsAggregate {
  project_id: string | null;
  label: string;
}

export interface UsageStatsSeriesPoint {
  bucket_start: string;
  provider?: UsageStatsProvider;
  model?: string | null;
  project_id?: string | null;
  label: string;
  metrics: UsageStatsMetrics;
}

export interface UsageStatsRange {
  period: UsageStatsPeriod;
  since: string;
  until: string;
  effective_until: string;
  timezone: "Asia/Seoul";
  bucket: "day" | "month";
}

export interface UsageStatsOptions {
  /**
   * Authorization-scoped to the allowed sessions and selected period/anchor.
   * Independent of provider, model, project, date, metric, and view filters.
   */
  providers: Array<{ provider: UsageStatsProvider; label: string }>;
  models: Array<{
    provider: UsageStatsProvider;
    model: string | null;
    backend: string;
    label: string;
  }>;
  projects: Array<{ project_id: string; label: string }>;
  project_roster: string[];
  model_rosters: Array<{ provider: UsageStatsProvider; models: Array<string | null> }>;
}

export interface UsageStatsOverview {
  schema_version: 1;
  generated_at: string;
  as_of: string;
  range: UsageStatsRange;
  policies: {
    date_attribution: "recorded_terminal";
    project_attribution: "current_folder";
    price_version: "api-list-usd-2026-10-19-v1";
  };
  projection_status: {
    state: "ready" | "backfilling";
    covered_since: string;
  };
  totals: UsageStatsAggregate;
  by_model: UsageStatsProviderRow[];
  by_project: UsageStatsProjectRow[];
  series: UsageStatsSeriesPoint[];
  options: UsageStatsOptions;
}

export interface UsageStatsInputPart {
  category: string;
  source_key: string | null;
  /** Estimate for this known source; hidden harness material is unobserved with this and share null. */
  approximate_tokens: number | null;
  /** Share uses the sum of known parts in this scope as its denominator, separate from provider input. */
  share: number | null;
  measurement: "reported" | "calibrated_estimate" | "estimate" | "unobserved";
}

export interface UsageStatsInputMaterial {
  basis: "observed_input_material";
  unit: "approximate_tokens";
  estimate_method: "utf16_chars_div4_ceil_v1";
  method: "combined_visible";
  /** Sum of known material parts only; it is not provider-reported input usage. */
  observed_approximate_tokens: number | null;
  parts: UsageStatsInputPart[];
  /** No same-scope source pairs are currently comparable, so no factor is applied. */
  calibration: {
    status: "not_comparable";
    sample_count: 0;
    factor: null;
    reasons: string[];
  };
  coverage: {
    complete_samples: number;
    partial_samples: number;
    manifest_only_samples: number;
    missing_samples: number;
  };
}

export interface UsageStatsDayDetail {
  schema_version: 1;
  date: string;
  generated_at: string;
  as_of: string;
  totals: UsageStatsAggregate;
  by_model: UsageStatsProviderRow[];
  by_project: UsageStatsProjectRow[];
  input_material: UsageStatsInputMaterial;
  tool_calls: number;
}
