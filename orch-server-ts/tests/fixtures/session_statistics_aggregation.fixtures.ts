import {
  selectOwnedSessionStatisticsRows,
  sessionStatisticsSourceKey,
} from "../../src/usage/session_statistics_aggregate.js";
import {
  createSessionStatisticsCoverageIndex,
  sessionStatisticsCoverage,
} from "../../src/usage/session_statistics_coverage.js";

export const timestamp = "2026-10-19T12:00:00.000Z";

export function fact(overrides: Record<string, unknown> = {}) {
  return {
    session_id: "session-1",
    event_id: 20,
    part_key: "usage:aggregate",
    fact_kind: "usage",
    recorded_at: timestamp,
    source_event_type: "complete",
    normalization_version: 1,
    accounting_key: "command-1",
    input_id: "input-1",
    candidate_type: "complete",
    provider: "claude",
    backend: "claude",
    model: "sonnet",
    usage_snapshot: null,
    quality: [],
    representation: "aggregate",
    input_total: 100,
    output_total: 20,
    total_tokens: 120,
    cache_read: null,
    cache_write: null,
    reasoning_output: null,
    known_cost_usd: 0.1,
    priced_tokens: 120,
    unpriced_tokens: 0,
    pricing_complete: true,
    pricing_version: "price-v1",
    raw_numeric: null,
    category: null,
    source_key: null,
    estimate_source: null,
    raw_chars_utf16: null,
    approximate_tokens: null,
    boundary_type: null,
    ...overrides,
  };
}

export function usageRow(overrides: Record<string, unknown> = {}) {
  return {
    row_kind: "usage",
    session_id: "session-1",
    selection_event_id: 20,
    input_id: "input-1",
    missing_identity: null,
    accounting_key: "command-1",
    owner_event_id: 20,
    candidate_event_id: null,
    candidate_type: "complete",
    representation: "aggregate",
    state: "owned",
    selection_quality: [],
    owner_recorded_at: timestamp,
    fact: fact(),
    ...overrides,
  };
}

export function boundaryRow(
  eventId: number,
  boundaryType: "input" | "command_started" | "session_ended",
  overrides: Record<string, unknown> = {},
) {
  return {
    row_kind: "boundary",
    session_id: "session-1",
    selection_event_id: eventId,
    input_id: boundaryType === "input" ? "input-1" : null,
    missing_identity: null,
    accounting_key: boundaryType === "command_started" ? "command-1" : null,
    owner_event_id: eventId,
    candidate_event_id: null,
    candidate_type: null,
    representation: "aggregate",
    state: "owned",
    selection_quality: [],
    owner_recorded_at: timestamp,
    fact: fact({
      event_id: eventId,
      part_key: `boundary/${boundaryType}`,
      fact_kind: "boundary",
      source_event_type: boundaryType === "input" ? "user_message" : boundaryType,
      accounting_key: boundaryType === "command_started" ? "command-1" : null,
      input_id: boundaryType === "input" ? "input-1" : null,
      candidate_type: null,
      representation: null,
      input_total: null,
      output_total: null,
      total_tokens: null,
      known_cost_usd: null,
      priced_tokens: null,
      unpriced_tokens: null,
      pricing_complete: null,
      boundary_type: boundaryType,
      ...overrides,
    }),
  };
}

export function missingRow(overrides: Record<string, unknown> = {}) {
  return usageRow({
    selection_event_id: 21,
    input_id: "input-1",
    accounting_key: null,
    owner_event_id: null,
    candidate_event_id: 21,
    candidate_type: "failed_result",
    representation: "diagnostic",
    state: "missing",
    owner_recorded_at: timestamp,
    fact: null,
    ...overrides,
  });
}

export function materialRow(
  eventId: number,
  sourceKey: string | null,
  approximateTokens: number | null,
  overrides: Record<string, unknown> = {},
) {
  const materialFact = fact({
    event_id: eventId,
    part_key: `material/${eventId}`,
    fact_kind: "input_material",
    source_event_type: "input_material_manifest",
    accounting_key: "command-1",
    input_id: "input-1",
    candidate_type: null,
    representation: null,
    input_total: null,
    output_total: null,
    total_tokens: null,
    known_cost_usd: null,
    priced_tokens: null,
    unpriced_tokens: null,
    pricing_complete: null,
    category: "user_prompt",
    source_key: sourceKey,
    estimate_source: "manifest",
    raw_chars_utf16: 8,
    approximate_tokens: approximateTokens,
  });
  return {
    row_kind: "input_material",
    session_id: "session-1",
    selection_event_id: eventId,
    input_id: "input-1",
    missing_identity: null,
    accounting_key: "command-1",
    owner_event_id: eventId,
    candidate_event_id: eventId,
    candidate_type: null,
    representation: null,
    state: "owned",
    selection_quality: [],
    owner_recorded_at: timestamp,
    fact: { ...materialFact, ...overrides },
  };
}

export function toolCallRow(eventId: number) {
  return {
    ...boundaryRow(eventId, "command_started"),
    row_kind: "tool_call",
    fact: fact({
      event_id: eventId,
      part_key: "tool_call",
      fact_kind: "tool_call",
      source_event_type: "tool_start",
      boundary_type: null,
      known_cost_usd: null,
    }),
  };
}

export function read(
  rows: unknown[],
  query: Record<string, unknown> = {},
  costDecimals = new Map([[sessionStatisticsSourceKey("session-1", 20, "usage:aggregate"), "0.1"]]),
  sessions: Array<{
    sessionId: string;
    folderId: string | null;
    cardFolderId: string | null;
    projectId: string | null;
    projectLabel: string;
  }> = [{ sessionId: "session-1", folderId: "folder-1", cardFolderId: null, projectId: "project-1", projectLabel: "Project" }],
) {
  return {
    query: { period: "week", anchor: "2026-10-19", ...query },
    asOf: "2026-10-20T00:00:00.000Z",
    range: {
      period: "week",
      since: "2026-10-19",
      until: "2026-10-26",
      effective_until: "2026-10-21",
      timezone: "Asia/Seoul",
      bucket: "day",
    },
    projectionStatus: { state: "ready", covered_since: "2026-10-01" },
    collectionCoverage: "unknown",
    sessions,
    rows,
    costDecimals,
  } as never;
}

export function coverage(rows: unknown[], query: Record<string, unknown> = {}) {
  const result = read(rows, query);
  const index = createSessionStatisticsCoverageIndex(result);
  const selected = selectOwnedSessionStatisticsRows(result);
  return sessionStatisticsCoverage(result, index, {}, selected);
}
