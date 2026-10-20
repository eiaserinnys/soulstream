import type {
  UsageStatsMetrics,
  UsageStatsProvider,
} from "@soulstream/wire-schema/session-statistics";
import type {
  SessionStatisticsReadResult,
  SessionStatisticsScopeSession,
} from "./session_statistics_types.js";
import { sessionStatisticsDate, sessionStatisticsInPeriod } from "./session_statistics_scope.js";
import {
  addDecimal,
  decimalNumber,
  parseDecimal,
  type Decimal,
} from "./session_statistics_decimal.js";
import { sourceTokenMetrics, sumKnownTokenMetrics } from "./session_statistics_token_metrics.js";
import { splitSourceCost } from "./session_statistics_costs.js";
export { sessionStatisticsDate, sessionStatisticsDateMatches } from "./session_statistics_scope.js";

type Row = SessionStatisticsReadResult["rows"][number];

export type SessionStatisticsScope = {
  provider?: UsageStatsProvider;
  model?: { value: string | null };
  projectIds?: readonly (string | null)[];
  date?: string;
  respectQueryFilters?: boolean;
};

export function sessionStatisticsSourceKey(
  sessionId: string,
  eventId: number | string,
  partKey: string,
): string {
  return JSON.stringify([sessionId, String(eventId), partKey]);
}

export function sessionStatisticsCompareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function sessionStatisticsEventOrder(row: Row): number {
  if (row.state === "ambiguous_legacy" && row.owner_recorded_at === null
    && row.fact?.fact_kind === "usage") return Number(row.fact.event_id);
  return row.owner_event_id ?? row.candidate_event_id ?? row.selection_event_id;
}

export function sessionStatisticsProjectMatches(projectId: string | null, ids: readonly string[]): boolean {
  return ids.some((id) => id === "__unclassified__" ? projectId === null : id === projectId);
}

const SESSION_STATISTICS_PROJECT_INDEX = new WeakMap<
  readonly SessionStatisticsScopeSession[],
  Map<string, string | null>
>();

export function sessionStatisticsProjectIdForSession(
  read: SessionStatisticsReadResult,
  sessionId: string,
): string | null {
  let index = SESSION_STATISTICS_PROJECT_INDEX.get(read.sessions);
  if (index === undefined) {
    index = new Map();
    for (const session of read.sessions) {
      if (!index.has(session.sessionId)) index.set(session.sessionId, session.projectId);
    }
    SESSION_STATISTICS_PROJECT_INDEX.set(read.sessions, index);
  }
  return index.get(sessionId) ?? null;
}

export function sessionStatisticsRowProjectMatches(
  read: SessionStatisticsReadResult,
  row: Row,
  scope: SessionStatisticsScope,
): boolean {
  const projectId = sessionStatisticsProjectIdForSession(read, row.session_id);
  return (scope.respectQueryFilters === false || read.query.project_ids === undefined
    || sessionStatisticsProjectMatches(projectId, read.query.project_ids))
    && (scope.projectIds === undefined || scope.projectIds.includes(projectId));
}

function rowTimestamp(row: Row): string | null {
  return row.owner_recorded_at ?? row.fact?.recorded_at ?? null;
}

export function selectOwnedSessionStatisticsRows(
  read: SessionStatisticsReadResult,
  scope: SessionStatisticsScope = {},
): Row[] {
  const seen = new Set<string>();
  const rows: Row[] = [];
  for (const row of read.rows) {
    if (row.row_kind !== "usage" || row.state !== "owned" || row.fact?.fact_kind !== "usage") continue;
    const fact = row.fact;
    if (!sessionStatisticsInPeriod(read, rowTimestamp(row))) continue;
    if (scope.respectQueryFilters !== false && read.query.provider != null
      && fact.provider !== read.query.provider) continue;
    if (scope.provider !== undefined && fact.provider !== scope.provider) continue;
    if (scope.respectQueryFilters !== false && read.query.model != null && fact.model !== read.query.model) continue;
    if (scope.model !== undefined && fact.model !== scope.model.value) continue;
    if (!sessionStatisticsRowProjectMatches(read, row, scope)) continue;
    if (scope.date !== undefined && sessionStatisticsDate(rowTimestamp(row)) !== scope.date) continue;
    const sourceKey = sessionStatisticsSourceKey(row.session_id, fact.event_id, fact.part_key);
    if (seen.has(sourceKey)) continue;
    seen.add(sourceKey);
    rows.push(row);
  }
  return rows;
}

function sumKnown(rows: readonly Row[], select: (row: Row) => number | null): number | null {
  let total = 0;
  let found = false;
  for (const row of rows) {
    const value = select(row);
    if (value === null) continue;
    total += value;
    found = true;
  }
  return found && Number.isSafeInteger(total) ? total : null;
}

export function aggregateSessionStatisticsMetrics(
  read: SessionStatisticsReadResult,
  sourceRows: readonly Row[],
): UsageStatsMetrics {
  const seen = new Set<string>();
  const rows: Row[] = [];
  let knownCost: Decimal | null = null;
  let cacheReadCost: Decimal | null = null;
  let nonCacheCost: Decimal | null = null;
  let hasCacheRead = false;
  let hasNonCache = false;
  let cacheReadPartial = false;
  let nonCachePartial = false;
  for (const row of sourceRows) {
    if (row.row_kind !== "usage" || row.state !== "owned" || row.fact?.fact_kind !== "usage") continue;
    const fact = row.fact;
    const key = sessionStatisticsSourceKey(row.session_id, fact.event_id, fact.part_key);
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(row);
    if (fact.known_cost_usd === null) {
      cacheReadPartial = true;
      nonCachePartial = true;
      continue;
    }
    const cost = read.costDecimals.get(key);
    if (cost === undefined) throw new Error("session statistics known cost is missing its decimal source");
    knownCost = addDecimal(knownCost, parseDecimal(cost));
    if (fact.cache_read === null) cacheReadPartial = true;
    const tokens = sourceTokenMetrics(fact);
    if (tokens.ordinary_input === null || tokens.total_tokens === null) nonCachePartial = true;
    const split = splitSourceCost(fact, cost);
    if (split === null) continue;
    if (split.cacheRead !== null) {
      cacheReadCost = hasCacheRead ? addDecimal(cacheReadCost, split.cacheRead) : split.cacheRead;
      hasCacheRead = true;
    } else cacheReadPartial = true;
    if (split.nonCache !== null) {
      nonCacheCost = hasNonCache ? addDecimal(nonCacheCost, split.nonCache) : split.nonCache;
      hasNonCache = true;
    } else nonCachePartial = true;
    cacheReadPartial = cacheReadPartial || split.cacheReadPartial;
    nonCachePartial = nonCachePartial || split.nonCachePartial;
  }

  return {
    input_total: sumKnown(rows, (row) => row.fact!.input_total),
    cache_read: sumKnown(rows, (row) => row.fact!.cache_read),
    cache_write: sumKnown(rows, (row) => row.fact!.cache_write),
    output_total: sumKnown(rows, (row) => row.fact!.output_total),
    reasoning_output: sumKnown(rows, (row) => row.fact!.reasoning_output),
    total_tokens: sumKnownTokenMetrics(rows.map((row) => sourceTokenMetrics(row.fact!).total_tokens)),
    provider_total_tokens: sumKnownTokenMetrics(rows.map((row) => sourceTokenMetrics(row.fact!).provider_total_tokens)),
    ordinary_input: sumKnownTokenMetrics(rows.map((row) => sourceTokenMetrics(row.fact!).ordinary_input)),
    reference_cost_usd: decimalNumber(knownCost),
    reference_cost_breakdown: {
      cache_read: {
        known_cost_usd: hasCacheRead ? decimalNumber(cacheReadCost) : null,
        is_partial: cacheReadPartial || !hasCacheRead,
      },
      non_cache: {
        known_cost_usd: hasNonCache ? decimalNumber(nonCacheCost) : null,
        is_partial: nonCachePartial || !hasNonCache,
      },
    },
  };
}
