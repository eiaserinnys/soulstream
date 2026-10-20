import type { SessionStatisticsReadResult } from "./session_statistics_types.js";

const SESSION_STATISTICS_DATE_FORMAT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Seoul",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const SESSION_STATISTICS_DATE_CACHE_LIMIT = 100_000;
const SESSION_STATISTICS_DATE_CACHE = new Map<string, string | null>();

function formatSessionStatisticsDate(timestamp: number): string {
  const parts = SESSION_STATISTICS_DATE_FORMAT.formatToParts(timestamp);
  const fields = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${fields.year}-${fields.month}-${fields.day}`;
}

export function sessionStatisticsDate(value: string | null): string | null {
  if (value === null) return null;
  if (SESSION_STATISTICS_DATE_CACHE.has(value)) return SESSION_STATISTICS_DATE_CACHE.get(value) ?? null;
  const timestamp = Date.parse(value);
  const date = Number.isFinite(timestamp) ? formatSessionStatisticsDate(timestamp) : null;
  SESSION_STATISTICS_DATE_CACHE.set(value, date);
  if (SESSION_STATISTICS_DATE_CACHE.size > SESSION_STATISTICS_DATE_CACHE_LIMIT) {
    SESSION_STATISTICS_DATE_CACHE.clear();
  }
  return date;
}

export function sessionStatisticsDateMatches(value: string | null, filter?: string): boolean {
  const date = sessionStatisticsDate(value);
  return filter === undefined || (filter.length === 7
    ? date?.startsWith(filter) === true
    : date === filter);
}

export function sessionStatisticsInPeriod(
  read: SessionStatisticsReadResult,
  timestamp: string | null,
): boolean {
  const date = sessionStatisticsDate(timestamp);
  return date !== null && read.range.since <= date && date < read.range.effective_until;
}
