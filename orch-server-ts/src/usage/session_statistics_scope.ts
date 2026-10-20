import type { SessionStatisticsReadResult } from "./session_statistics_types.js";

const SESSION_STATISTICS_DATE_FORMAT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Seoul",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function sessionStatisticsDate(value: string | null): string | null {
  if (value === null) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  const parts = SESSION_STATISTICS_DATE_FORMAT.formatToParts(timestamp);
  const fields = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${fields.year}-${fields.month}-${fields.day}`;
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
