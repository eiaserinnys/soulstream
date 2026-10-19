import type { UsageStatsProvider } from "@soulstream/wire-schema/session-statistics";

export type SessionStatisticsEventInput = {
  sessionId: string;
  eventId: number | string;
  eventType: string;
  createdAt: string;
  payload: unknown;
};

export type UsageCandidateType =
  | "complete"
  | "failed_error"
  | "failed_result"
  | "interrupt_observation"
  | "success_result"
  | "diagnostic";

export type FactDraft = {
  session_id: string;
  event_id: number | string;
  part_key: string;
  fact_kind: "usage" | "input_material" | "tool_call" | "boundary";
  recorded_at: string;
  source_event_type: string;
  normalization_version: 1;
  accounting_key: string | null;
  input_id: string | null;
  candidate_type: UsageCandidateType | null;
  provider: UsageStatsProvider;
  backend: string | null;
  model: string | null;
  usage_snapshot: Record<string, unknown> | null;
  quality: string[];
  representation: "aggregate" | "model_breakdown" | "diagnostic" | null;
  input_total: number | null;
  output_total: number | null;
  total_tokens: number | null;
  cache_read: number | null;
  cache_write: number | null;
  reasoning_output: number | null;
  known_cost_usd: number | null;
  priced_tokens: number | null;
  unpriced_tokens: number | null;
  pricing_complete: boolean | null;
  pricing_version: string | null;
  raw_numeric: Record<string, unknown> | null;
  category: string | null;
  source_key: string | null;
  estimate_source: string | null;
  raw_chars_utf16: number | null;
  approximate_tokens: number | null;
  boundary_type: "input" | "command_started" | "session_ended" | null;
};

export type UsageSnapshot = {
  schema_version: 1;
  backend: string;
  provider: UsageStatsProvider;
  preset_id: string | null;
  requested_model: string | null;
  provider_attribution: "configured_alias" | "unknown";
};

export type EventIdentity = {
  accountingKey: string | null;
  inputId: string | null;
  provider: UsageStatsProvider;
  backend: string | null;
  model: string | null;
  snapshot: UsageSnapshot | null;
  quality: string[];
};

export type NormalizedUsage = {
  input_total: number | null;
  output_total: number | null;
  total_tokens: number | null;
  cache_read: number | null;
  cache_write: number | null;
  reasoning_output: number | null;
};

export type CanonicalUsageSelection = {
  sessionId: string;
  accountingKey: string | null;
  ownerEventId: number | string | null;
  candidateEventId: number | string | null;
  candidateType: UsageCandidateType | null;
  representation: FactDraft["representation"];
  state: "owned" | "pending" | "missing" | "ambiguous_legacy" | "unresolved_legacy" | "identity_conflict";
  facts: FactDraft[];
  quality: string[];
};
