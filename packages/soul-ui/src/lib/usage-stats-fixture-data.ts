// Deterministic synthetic source records for usage statistics.
import type { UsageStatsProvider as FixtureUsageStatsProvider } from "../../../wire-schema/src/session_statistics";

export { USAGE_STATS_PROVIDERS } from "../../../wire-schema/src/session_statistics";
export type {
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
} from "../../../wire-schema/src/session_statistics";

export const USAGE_STATS_FIXTURE_ANCHOR = "2026-10-18";
export const USAGE_STATS_FIXTURE_AS_OF = "2026-10-19T00:00:00+09:00";
// Collection evidence is separate from the presence of usage rows.
export const USAGE_STATS_COLLECTION = {
  since: "2026-09-01",
  until: "2026-10-19",
  providers: { claude: "complete", codex: "complete", antigravity: "complete", deepseek: "unknown", kimi: "complete", unknown: "unknown" },
} as const;

export interface RawUsageRecord {
  date: string;
  provider: FixtureUsageStatsProvider;
  backend: string;
  model: string;
  project_id: string | null;
  input_total: number | null;
  cache_read: number | null;
  cache_write: number | null;
  output_total: number | null;
  reasoning_output: number | null;
  reference_cost_usd: number | null;
  cache_read_cost_usd: number | null;
  non_cache_cost_usd: number | null;
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
  provider: FixtureUsageStatsProvider | null;
  model: string | null;
  project_id: string | null;
  category: string;
  source_key: string | null;
  chars: number;
  approximate_tokens: number | null;
  estimate_source: "manifest" | "derived_chars";
}

export interface RawToolCallRecord {
  date: string;
  provider: FixtureUsageStatsProvider;
  model: string;
  project_id: string | null;
  calls: number;
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
  { date: "2026-09-10", provider: "claude", backend: "claude-code", model: "claude-opus-5.5", project_id: "project-docs", input_total: 1_000_000, cache_read: 400_000, cache_write: 0, output_total: 300_000, reasoning_output: 0, reference_cost_usd: 9.2, cache_read_cost_usd: 0.08, non_cache_cost_usd: 9.12 },
  { date: "2026-09-24", provider: "codex", backend: "codex", model: "gpt-6.1-sol", project_id: "project-tooling", input_total: 500_000, cache_read: 100_000, cache_write: 0, output_total: 150_000, reasoning_output: 30_000, reference_cost_usd: 2.8, cache_read_cost_usd: 0.01, non_cache_cost_usd: 2.79 },
  { date: "2026-09-30", provider: "antigravity", backend: "antigravity", model: "gemini-3.8-flash", project_id: null, input_total: 300_000, cache_read: 50_000, cache_write: 0, output_total: 120_000, reasoning_output: 20_000, reference_cost_usd: 0.7, cache_read_cost_usd: 0.00375, non_cache_cost_usd: 0.69625 },
  { date: "2026-10-12", provider: "claude", backend: "claude-code", model: "claude-opus-5.5", project_id: "project-web-dashboard", input_total: 1_200_000, cache_read: 600_000, cache_write: 0, output_total: 400_000, reasoning_output: 80_000, reference_cost_usd: 10, cache_read_cost_usd: 0.12, non_cache_cost_usd: 9.88 },
  { date: "2026-10-13", provider: "codex", backend: "codex", model: "gpt-6.1-sol", project_id: "project-mobile-app", input_total: 850_000, cache_read: 300_000, cache_write: 0, output_total: 350_000, reasoning_output: 90_000, reference_cost_usd: 5, cache_read_cost_usd: 0.03, non_cache_cost_usd: 4.97 },
  { date: "2026-10-14", provider: "antigravity", backend: "antigravity", model: "gemini-3.8-flash", project_id: "project-docs", input_total: 500_000, cache_read: 150_000, cache_write: 0, output_total: 300_000, reasoning_output: 70_000, reference_cost_usd: 2, cache_read_cost_usd: 0.01125, non_cache_cost_usd: 1.98875 },
  { date: "2026-10-15", provider: "codex", backend: "codex", model: "gpt-6-luna", project_id: "project-experiments", input_total: 0, cache_read: 0, cache_write: 0, output_total: 0, reasoning_output: 0, reference_cost_usd: 0, cache_read_cost_usd: 0, non_cache_cost_usd: 0 },
  { date: "2026-10-16", provider: "claude", backend: "claude-code", model: "claude-sonnet-5.5", project_id: "project-web-dashboard", input_total: 600_000, cache_read: 250_000, cache_write: 0, output_total: 250_000, reasoning_output: 45_000, reference_cost_usd: 3, cache_read_cost_usd: 0.025, non_cache_cost_usd: 2.975 },
  { date: "2026-10-16", provider: "kimi", backend: "kimi-for-coding", model: "kimi-for-coding/k3", project_id: "project-mobile-app", input_total: 800_000, cache_read: 600_000, cache_write: 0, output_total: 200_000, reasoning_output: 40_000, reference_cost_usd: null, cache_read_cost_usd: null, non_cache_cost_usd: null },
  { date: "2026-10-17", provider: "codex", backend: "codex", model: "gpt-6-luna", project_id: "project-data-collection", input_total: 200_000, cache_read: 50_000, cache_write: 0, output_total: 100_000, reasoning_output: 20_000, reference_cost_usd: 1, cache_read_cost_usd: 0.0005, non_cache_cost_usd: 0.9995 },
  { date: "2026-10-18", provider: "antigravity", backend: "antigravity", model: "gemini-4-argon", project_id: "project-experiments", input_total: 400_000, cache_read: 150_000, cache_write: 0, output_total: 200_000, reasoning_output: 60_000, reference_cost_usd: 2, cache_read_cost_usd: 0.015, non_cache_cost_usd: 1.985 },
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
  { date: "2026-10-16", sample_id: "claude-web-1016", provider: "claude", model: "claude-sonnet-5.5", project_id: "project-web-dashboard", category: "system_prompt", source_key: "system-prompt", chars: 250_000, approximate_tokens: 62_500, estimate_source: "derived_chars" },
  { date: "2026-10-16", sample_id: "claude-web-1016", provider: "claude", model: "claude-sonnet-5.5", project_id: "project-web-dashboard", category: "soulstream_injection", source_key: "soulstream-injection", chars: 180_000, approximate_tokens: 45_000, estimate_source: "derived_chars" },
  { date: "2026-10-16", sample_id: "claude-web-1016", provider: "claude", model: "claude-sonnet-5.5", project_id: "project-web-dashboard", category: "user_prompt", source_key: "user-prompt", chars: 130_000, approximate_tokens: 32_500, estimate_source: "derived_chars" },
  { date: "2026-10-16", sample_id: "claude-web-1016", provider: "claude", model: "claude-sonnet-5.5", project_id: "project-web-dashboard", category: "tool_result", source_key: "tool-result", chars: 312_000, approximate_tokens: 78_000, estimate_source: "derived_chars" },
  { date: "2026-10-16", sample_id: "kimi-mobile-1016", provider: "kimi", model: "kimi-for-coding/k3", project_id: "project-mobile-app", category: "system_prompt", source_key: "system-prompt", chars: 70_000, approximate_tokens: 17_500, estimate_source: "derived_chars" },
  { date: "2026-10-16", sample_id: "kimi-mobile-1016", provider: "kimi", model: "kimi-for-coding/k3", project_id: "project-mobile-app", category: "user_prompt", source_key: "user-prompt", chars: 190_000, approximate_tokens: 47_500, estimate_source: "derived_chars" },
];

export const RAW_TOOL_CALLS: RawToolCallRecord[] = [
  { date: "2026-10-16", provider: "claude", model: "claude-sonnet-5.5", project_id: "project-web-dashboard", calls: 312 },
];
