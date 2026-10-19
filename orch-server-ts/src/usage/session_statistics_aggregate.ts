import type {
  UsageStatsMetrics,
  UsageStatsProvider,
} from "@soulstream/wire-schema/session-statistics";
import type { SessionStatisticsReadResult } from "./session_statistics_types.js";

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

export function sessionStatisticsDate(value: string | null): string | null {
  if (value === null) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(timestamp);
  const fields = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${fields.year}-${fields.month}-${fields.day}`;
}

export function sessionStatisticsDateMatches(value: string | null, filter?: string): boolean {
  const date = sessionStatisticsDate(value);
  return filter === undefined || (filter.length === 7
    ? date?.startsWith(filter) === true
    : date === filter);
}

export function sessionStatisticsProjectMatches(projectId: string | null, ids: readonly string[]): boolean {
  return ids.some((id) => id === "__unclassified__" ? projectId === null : id === projectId);
}

function sessionProjectId(read: SessionStatisticsReadResult, sessionId: string): string | null {
  return read.sessions.find((session) => session.sessionId === sessionId)?.projectId ?? null;
}

export function sessionStatisticsRowProjectMatches(
  read: SessionStatisticsReadResult,
  row: Row,
  scope: SessionStatisticsScope,
): boolean {
  const projectId = sessionProjectId(read, row.session_id);
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

type Decimal = { coefficient: bigint; scale: number };

function parseDecimal(value: string): Decimal {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) throw new Error("session statistics cost decimal is invalid");
  const fraction = match[3] ?? "";
  const sign = match[1] === "-" ? "-" : "";
  return { coefficient: BigInt(`${sign}${match[2]}${fraction}`), scale: fraction.length };
}

function addDecimal(total: Decimal | null, next: Decimal): Decimal {
  if (total === null) return next;
  const scale = Math.max(total.scale, next.scale);
  const left = total.coefficient * 10n ** BigInt(scale - total.scale);
  const right = next.coefficient * 10n ** BigInt(scale - next.scale);
  return { coefficient: left + right, scale };
}

function decimalNumber(value: Decimal | null): number | null {
  return value === null ? null : Number(value.coefficient) / 10 ** value.scale;
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
  return found ? total : null;
}

export function aggregateSessionStatisticsMetrics(
  read: SessionStatisticsReadResult,
  sourceRows: readonly Row[],
): UsageStatsMetrics {
  const seen = new Set<string>();
  const rows: Row[] = [];
  let knownCost: Decimal | null = null;
  for (const row of sourceRows) {
    if (row.row_kind !== "usage" || row.state !== "owned" || row.fact?.fact_kind !== "usage") continue;
    const fact = row.fact;
    const key = sessionStatisticsSourceKey(row.session_id, fact.event_id, fact.part_key);
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(row);
    if (fact.known_cost_usd === null) continue;
    const cost = read.costDecimals.get(key);
    if (cost === undefined) throw new Error("session statistics known cost is missing its decimal source");
    knownCost = addDecimal(knownCost, parseDecimal(cost));
  }

  return {
    input_total: sumKnown(rows, (row) => row.fact!.input_total),
    cache_read: sumKnown(rows, (row) => row.fact!.cache_read),
    cache_write: sumKnown(rows, (row) => row.fact!.cache_write),
    output_total: sumKnown(rows, (row) => row.fact!.output_total),
    reasoning_output: sumKnown(rows, (row) => row.fact!.reasoning_output),
    total_tokens: sumKnown(rows, (row) => row.fact!.input_total !== null && row.fact!.output_total !== null
      ? row.fact!.total_tokens
      : null),
    reference_cost_usd: decimalNumber(knownCost),
  };
}
