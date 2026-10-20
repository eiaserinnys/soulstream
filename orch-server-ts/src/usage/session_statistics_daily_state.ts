import type { UsageStatsCoverage, UsageStatsDayDetail, UsageStatsOptions, UsageStatsProvider } from "@soulstream/wire-schema/session-statistics";
import { USAGE_STATS_PROVIDERS } from "@soulstream/wire-schema/session-statistics";
import { createSessionStatisticsMetricState, selectOwnedSessionStatisticsRows, sessionStatisticsDate,
  type SessionStatisticsMetricState, type SessionStatisticsScope } from "./session_statistics_aggregate.js";
import { createSessionStatisticsCoverageIndex, sessionStatisticsCoverage } from "./session_statistics_coverage.js";
import { buildSessionStatisticsMaterial } from "./session_statistics_material.js";
import { buildSessionStatisticsOptions } from "./session_statistics_options.js";
import type { SessionStatisticsReadResult } from "./session_statistics_types.js";

// Bump for aggregation, normalization, or pricing policy changes.
export const SESSION_STATISTICS_DAILY_AGGREGATION_VERSION = 1;
export type DailySelector = { provider?: UsageStatsProvider; model?: { value: string | null } };
export type DailyMaterial = Pick<UsageStatsDayDetail, "input_material" | "tool_calls">;
export type DailyAggregateState = {
  metrics: SessionStatisticsMetricState;
  coverage: UsageStatsCoverage;
  sourceCount: number;
  tokenEvidence: boolean;
  material: DailyMaterial;
};
export type DailySessionState = {
  sessionId: string;
  folderId?: string | null;
  cardFolderId?: string | null;
  selectors: Record<string, DailyAggregateState>;
  options: UsageStatsOptions["models"];
  hasUsage: boolean;
  unattributedAllFields: boolean;
};
export type SessionStatisticsDailyState = {
  day: string;
  version: number;
  asOf: string;
  sessions: DailySessionState[];
  groups?: DailyGroupState[];
};
export type DailyOverviewAggregateState = Omit<DailyAggregateState, "material">;
export type DailyGroupState = {
  folderId: string | null;
  cardFolderId: string | null;
  selectors: Record<string, DailyOverviewAggregateState>;
  options: DailySessionState["options"];
  hasUsage: boolean;
  unattributedAllFields: boolean;
};

export function dailySelectorKey(selector: DailySelector): string {
  return JSON.stringify([selector.provider ?? null, selector.model === undefined ? [] : [selector.model.value]]);
}

/** Existing canonical/coverage/metric policies prepare each disjoint session slice. */
export function createSessionStatisticsDailyState(read: SessionStatisticsReadResult, day: string): SessionStatisticsDailyState {
  const grouped = new Map<string, SessionStatisticsReadResult["rows"][number][]>();
  for (const row of read.rows) {
    const group = grouped.get(row.session_id) ?? [];
    group.push(row);
    grouped.set(row.session_id, group);
  }
  const sessions: DailySessionState[] = [];
  for (const session of read.sessions) {
    const rows = grouped.get(session.sessionId);
    if (rows === undefined) continue;
    const next = new Date(`${day}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    const slice = { ...read, query: { period: read.query.period, anchor: read.query.anchor },
      range: { ...read.range, since: day, effective_until: next.toISOString().slice(0, 10) },
      sessions: [session], rows };
    const index = createSessionStatisticsCoverageIndex(slice);
    const options = buildSessionStatisticsOptions(slice, index).models;
    const selectors = new Map<string, DailySelector>();
    const add = (selector: DailySelector) => selectors.set(dailySelectorKey(selector), selector);
    add({});
    for (const provider of USAGE_STATS_PROVIDERS) add({ provider });
    for (const option of options) {
      add({ provider: option.provider, model: { value: option.model } });
      add({ model: { value: option.model } });
    }
    const unattributedAllFields = index.missing.some(record => record.attribution === null
      && sessionStatisticsDate(record.timestamp) === day && record.unknownAllUsageFields);
    const prepared: DailySessionState["selectors"] = {};
    for (const [key, selector] of selectors) {
      const scope: SessionStatisticsScope = { ...selector, date: day };
      const selected = selectOwnedSessionStatisticsRows(slice, scope);
      const coverage = sessionStatisticsCoverage(slice, index, scope, selected);
      prepared[key] = {
        metrics: createSessionStatisticsMetricState(slice, selected), coverage, sourceCount: selected.length,
        tokenEvidence: selected.length > 0 || coverage.usage_partial_events > 0
          || coverage.missing_usage_turns > 0 || unattributedAllFields,
        material: buildSessionStatisticsMaterial(slice, day, scope),
      };
    }
    sessions.push({ sessionId: session.sessionId, folderId: session.folderId,
      cardFolderId: session.cardFolderId, selectors: prepared, options,
      hasUsage: rows.some(row => row.row_kind === "usage"),
      unattributedAllFields,
    });
  }
  return { day, version: SESSION_STATISTICS_DAILY_AGGREGATION_VERSION, asOf: read.asOf, sessions };
}
