// Public API types and deterministic synthetic source records for usage statistics.
export type UsageStatsPeriod = "week" | "month" | "all";
export type UsageStatsProvider = "claude" | "codex" | "antigravity" | "deepseek" | "kimi";

export const USAGE_STATS_FIXTURE_ANCHOR = "2026-10-18";
export const USAGE_STATS_FIXTURE_AS_OF = "2026-10-19T00:00:00+09:00";
export const USAGE_STATS_PROVIDERS: UsageStatsProvider[] = ["claude", "codex", "antigravity", "deepseek", "kimi"];

export interface UsageStatsQuery {
  period: UsageStatsPeriod;
  anchor: string;
  provider?: UsageStatsProvider | null;
  model?: string | null;
  project_ids?: readonly string[];
}

export interface UsageStatsMetrics {
  input_total: number | null;
  cache_read: number | null;
  cache_write: number | null;
  output_total: number | null;
  reasoning_output: number | null;
  total_tokens: number | null;
  reference_cost_usd: number | null;
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
}

export interface UsageStatsInputPart {
  category: string;
  source_key: string | null;
  chars: number | null;
  share: number | null;
}

export interface UsageStatsInputMaterial {
  basis: "observed_input_material";
  unit: "chars_utf16";
  method: "combined_visible";
  observed_chars: number | null;
  parts: UsageStatsInputPart[];
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

export interface RawUsageRecord {
  date: string;
  provider: UsageStatsProvider;
  backend: string;
  model: string;
  project_id: string | null;
  input_total: number | null;
  cache_read: number | null;
  cache_write: number | null;
  output_total: number | null;
  reasoning_output: number | null;
  reference_cost_usd: number | null;
}

export interface MissingTurnRecord {
  id: string;
  date: string;
  project_id: string | null;
  terminal: boolean;
  ended: boolean;
}

export interface PendingTurnRecord {
  date: string;
  project_id: string | null;
}

export interface RawInputMaterialRecord {
  date: string;
  sample_id: string;
  provider: UsageStatsProvider | null;
  model: string | null;
  project_id: string | null;
  category: string;
  source_key: string | null;
  chars: number;
}

export interface ProjectGroup {
  project_id: string | null;
  label: string;
  records: RawUsageRecord[];
}

export const PROJECT_LABELS: Record<string, string> = {
  "project-web-dashboard": "웹 대시보드",
  "project-mobile-app": "모바일 앱",
  "project-docs": "문서 사이트",
  "project-data-collection": "데이터 수집",
  "project-experiments": "실험",
  "project-tooling": "개발 도구",
  "project-evaluation": "평가 자료",
};

export const RAW_USAGE_RECORDS: RawUsageRecord[] = [
  { date: "2026-09-10", provider: "claude", backend: "claude-code", model: "claude-opus-5.5", project_id: "project-docs", input_total: 1_000_000, cache_read: 400_000, cache_write: 0, output_total: 300_000, reasoning_output: 0, reference_cost_usd: 9.2 },
  { date: "2026-09-24", provider: "codex", backend: "codex", model: "gpt-6.1-sol", project_id: "project-tooling", input_total: 500_000, cache_read: 100_000, cache_write: 0, output_total: 150_000, reasoning_output: 30_000, reference_cost_usd: 2.8 },
  { date: "2026-09-30", provider: "antigravity", backend: "antigravity", model: "gemini-3.8-flash", project_id: null, input_total: 300_000, cache_read: 50_000, cache_write: 0, output_total: 120_000, reasoning_output: 20_000, reference_cost_usd: 0.7 },
  { date: "2026-10-12", provider: "claude", backend: "claude-code", model: "claude-opus-5.5", project_id: "project-web-dashboard", input_total: 1_200_000, cache_read: 600_000, cache_write: 0, output_total: 400_000, reasoning_output: 80_000, reference_cost_usd: 10 },
  { date: "2026-10-13", provider: "codex", backend: "codex", model: "gpt-6.1-sol", project_id: "project-mobile-app", input_total: 850_000, cache_read: 300_000, cache_write: 0, output_total: 350_000, reasoning_output: 90_000, reference_cost_usd: 5 },
  { date: "2026-10-14", provider: "antigravity", backend: "antigravity", model: "gemini-3.8-flash", project_id: "project-docs", input_total: 500_000, cache_read: 150_000, cache_write: 0, output_total: 300_000, reasoning_output: 70_000, reference_cost_usd: 2 },
  { date: "2026-10-15", provider: "codex", backend: "codex", model: "gpt-6-luna", project_id: "project-experiments", input_total: 0, cache_read: 0, cache_write: 0, output_total: 0, reasoning_output: 0, reference_cost_usd: 0 },
  { date: "2026-10-16", provider: "claude", backend: "claude-code", model: "claude-sonnet-5.5", project_id: "project-web-dashboard", input_total: 600_000, cache_read: 250_000, cache_write: 0, output_total: 250_000, reasoning_output: 45_000, reference_cost_usd: 3 },
  { date: "2026-10-16", provider: "kimi", backend: "kimi-for-coding", model: "kimi-for-coding/k3", project_id: "project-mobile-app", input_total: 800_000, cache_read: 600_000, cache_write: 0, output_total: 200_000, reasoning_output: 40_000, reference_cost_usd: null },
  { date: "2026-10-17", provider: "codex", backend: "codex", model: "gpt-6-luna", project_id: "project-data-collection", input_total: 200_000, cache_read: 50_000, cache_write: 0, output_total: 100_000, reasoning_output: 20_000, reference_cost_usd: 1 },
  { date: "2026-10-18", provider: "antigravity", backend: "antigravity", model: "gemini-4-argon", project_id: "project-experiments", input_total: 400_000, cache_read: 150_000, cache_write: 0, output_total: 200_000, reasoning_output: 60_000, reference_cost_usd: 2 },
];

export const MISSING_TURNS: MissingTurnRecord[] = [
  { id: "missing-01", date: "2026-10-12", project_id: "project-web-dashboard", terminal: true, ended: false },
  { id: "missing-02", date: "2026-10-12", project_id: "project-web-dashboard", terminal: true, ended: false },
  { id: "missing-03", date: "2026-10-13", project_id: "project-mobile-app", terminal: true, ended: false },
  { id: "missing-04", date: "2026-10-13", project_id: "project-mobile-app", terminal: true, ended: false },
  { id: "missing-05", date: "2026-10-14", project_id: "project-docs", terminal: true, ended: false },
  { id: "missing-06", date: "2026-10-14", project_id: "project-docs", terminal: true, ended: false },
  { id: "missing-07", date: "2026-10-15", project_id: "project-experiments", terminal: true, ended: true },
  { id: "missing-08", date: "2026-10-15", project_id: "project-experiments", terminal: true, ended: true },
  { id: "missing-09", date: "2026-10-16", project_id: "project-web-dashboard", terminal: true, ended: true },
  { id: "missing-10", date: "2026-10-16", project_id: "project-mobile-app", terminal: true, ended: true },
  { id: "missing-11", date: "2026-10-16", project_id: "project-web-dashboard", terminal: false, ended: true },
  { id: "missing-12", date: "2026-10-17", project_id: "project-data-collection", terminal: false, ended: true },
  { id: "missing-13", date: "2026-10-17", project_id: "project-data-collection", terminal: false, ended: true },
  { id: "missing-14", date: "2026-10-18", project_id: null, terminal: false, ended: true },
];

export const PENDING_TURNS: PendingTurnRecord[] = [
  { date: "2026-10-17", project_id: "project-data-collection" },
  { date: "2026-10-18", project_id: "project-experiments" },
  { date: "2026-10-18", project_id: null },
];

export const RAW_INPUT_MATERIAL: RawInputMaterialRecord[] = [
  { date: "2026-10-16", sample_id: "claude-web-1016", provider: "claude", model: "claude-sonnet-5.5", project_id: "project-web-dashboard", category: "system_prompt", source_key: "system-prompt", chars: 250_000 },
  { date: "2026-10-16", sample_id: "claude-web-1016", provider: "claude", model: "claude-sonnet-5.5", project_id: "project-web-dashboard", category: "soulstream_injection", source_key: "soulstream-injection", chars: 180_000 },
  { date: "2026-10-16", sample_id: "claude-web-1016", provider: "claude", model: "claude-sonnet-5.5", project_id: "project-web-dashboard", category: "user_prompt", source_key: "user-prompt", chars: 130_000 },
  { date: "2026-10-16", sample_id: "claude-web-1016", provider: "claude", model: "claude-sonnet-5.5", project_id: "project-web-dashboard", category: "tool_result", source_key: "tool-result", chars: 312_000 },
  { date: "2026-10-16", sample_id: "kimi-mobile-1016", provider: "kimi", model: "kimi-for-coding/k3", project_id: "project-mobile-app", category: "system_prompt", source_key: "system-prompt", chars: 70_000 },
  { date: "2026-10-16", sample_id: "kimi-mobile-1016", provider: "kimi", model: "kimi-for-coding/k3", project_id: "project-mobile-app", category: "user_prompt", source_key: "user-prompt", chars: 190_000 },
];
