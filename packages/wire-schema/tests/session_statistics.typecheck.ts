import {
  USAGE_STATS_PROVIDERS,
  USAGE_STATS_UNKNOWN_PROVIDER_LABEL,
} from "@soulstream/wire-schema/session-statistics";
import type {
  UsageStatsAggregate,
  UsageStatsCoverage,
  UsageStatsDayDetail,
  UsageStatsInputMaterial,
  UsageStatsInputPart,
  UsageStatsMetrics,
  UsageStatsOptions,
  UsageStatsOverview,
  UsageStatsPeriod,
  UsageStatsProjectRow,
  UsageStatsProvider,
  UsageStatsProviderRow,
  UsageStatsQuery,
  UsageStatsRange,
  UsageStatsSeriesPoint,
} from "@soulstream/wire-schema/session-statistics";

const period: UsageStatsPeriod = "week";
const query: UsageStatsQuery = {
  period,
  anchor: "2026-10-19",
  provider: "unknown",
  model: null,
  project_ids: ["project-1"],
};
const metrics: UsageStatsMetrics = {
  input_total: 10,
  cache_read: null,
  cache_write: null,
  output_total: 2,
  reasoning_output: null,
  total_tokens: 12,
  reference_cost_usd: null,
};
const coverage: UsageStatsCoverage = {
  usage_complete_events: 1,
  usage_partial_events: 0,
  terminal_missing_usage: 0,
  ended_input_without_usage: 0,
  missing_usage_turns: 0,
  pending_inputs: 0,
  priced_events: 0,
  unpriced_events: 1,
  priced_total_tokens: null,
  unpriced_total_tokens: 12,
  unknown_total_token_events: 0,
  unattributed_missing_usage: false,
};
const aggregate: UsageStatsAggregate = { metrics, coverage, is_partial: false };
const providerRow: UsageStatsProviderRow = {
  ...aggregate,
  provider: "unknown",
  backend: "unknown",
  model: null,
  attribution: "provider",
};
const projectRow: UsageStatsProjectRow = {
  ...aggregate,
  project_id: null,
  label: "기타",
};
const seriesPoint: UsageStatsSeriesPoint = {
  bucket_start: "2026-10-19",
  provider: "unknown",
  model: null,
  project_id: null,
  label: USAGE_STATS_UNKNOWN_PROVIDER_LABEL,
  metrics,
};
const range: UsageStatsRange = {
  period,
  since: "2026-10-19",
  until: "2026-10-26",
  effective_until: "2026-10-20",
  timezone: "Asia/Seoul",
  bucket: "day",
};
const options: UsageStatsOptions = {
  providers: [{ provider: "unknown", label: USAGE_STATS_UNKNOWN_PROVIDER_LABEL }],
  models: [{ provider: "unknown", model: null, backend: "unknown", label: "미확인 모델" }],
  projects: [{ project_id: "project-1", label: "프로젝트 1" }],
  project_roster: ["project-1"],
  model_rosters: [{ provider: "unknown", models: [null] }],
};
const part: UsageStatsInputPart = {
  category: "hidden_harness",
  source_key: null,
  approximate_tokens: null,
  share: null,
  measurement: "unobserved",
};
const measurements: UsageStatsInputPart["measurement"][] = [
  "reported",
  "calibrated_estimate",
  "estimate",
  "unobserved",
];
const inputMaterial: UsageStatsInputMaterial = {
  basis: "observed_input_material",
  unit: "approximate_tokens",
  estimate_method: "utf16_chars_div4_ceil_v1",
  method: "combined_visible",
  observed_approximate_tokens: null,
  parts: [part],
  calibration: {
    status: "not_comparable",
    sample_count: 0,
    factor: null,
    reasons: ["missing_source_token_breakdown"],
  },
  coverage: {
    complete_samples: 0,
    partial_samples: 0,
    manifest_only_samples: 0,
    missing_samples: 1,
  },
};
const overview: UsageStatsOverview = {
  schema_version: 1,
  generated_at: "2026-10-19T00:00:00+09:00",
  as_of: "2026-10-19T00:00:00+09:00",
  range,
  policies: {
    date_attribution: "recorded_terminal",
    project_attribution: "current_folder",
    price_version: "api-list-usd-2026-10-19-v1",
  },
  projection_status: { state: "ready", covered_since: "2026-09-01" },
  totals: aggregate,
  by_model: [providerRow],
  by_project: [projectRow],
  series: [seriesPoint],
  options,
};
const dayDetail: UsageStatsDayDetail = {
  schema_version: 1,
  date: "2026-10-19",
  generated_at: "2026-10-19T00:00:00+09:00",
  as_of: "2026-10-19T00:00:00+09:00",
  totals: aggregate,
  by_model: [providerRow],
  by_project: [projectRow],
  input_material: inputMaterial,
  tool_calls: 0,
};
const provider: UsageStatsProvider = "unknown";
const providers: readonly UsageStatsProvider[] = USAGE_STATS_PROVIDERS;
const unknownProviderLabel: "공급자 미확인" = USAGE_STATS_UNKNOWN_PROVIDER_LABEL;

// @ts-expect-error Providers are the five named providers plus the explicit unknown case.
const invalidProvider: UsageStatsProvider = "unlisted";

void [query, metrics, coverage, aggregate, providerRow, projectRow, seriesPoint, range,
  options, part, measurements, inputMaterial, overview, dayDetail, provider, providers,
  unknownProviderLabel, invalidProvider];
