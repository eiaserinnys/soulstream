import type {
  UsageStatsQuery,
  UsageStatsRange,
} from "@soulstream/wire-schema/session-statistics";

const TIMEZONE = "Asia/Seoul" as const;

export type SessionStatisticsPeriod = {
  range: UsageStatsRange;
  recordedAtFrom: string;
  recordedAtBefore: string;
  empty: boolean;
};

export type SessionStatisticsDayRange = {
  recordedAtFrom: string;
  recordedAtBefore: string;
};

export function resolveSessionStatisticsPeriod(
  query: UsageStatsQuery,
  asOf: string,
  authorizedEarliest: string | null,
): SessionStatisticsPeriod {
  const asOfDate = parseOffsetTimestamp(asOf, "asOf");
  const today = kstDate(asOfDate);
  const tomorrow = addDays(today, 1);
  const anchor = parseCalendarDate(query.anchor, "anchor");

  let since: string;
  let until: string;
  let bucket: UsageStatsRange["bucket"];
  if (query.period === "week") {
    const weekday = calendarDayOfWeek(anchor);
    since = addDays(anchor, -((weekday + 6) % 7));
    until = addDays(since, 7);
    bucket = "day";
  } else if (query.period === "month") {
    since = `${anchor.slice(0, 7)}-01`;
    until = addMonths(since, 1);
    bucket = "day";
  } else {
    const earliest = authorizedEarliest === null
      ? null
      : kstDate(parseOffsetTimestamp(authorizedEarliest, "authorizedEarliest"));
    since = earliest ?? today;
    until = tomorrow;
    bucket = "month";
  }

  const effectiveUntil = minDate(until, tomorrow);
  const effectiveUntilClamped = effectiveUntil < since ? since : effectiveUntil;
  const range: UsageStatsRange = {
    period: query.period,
    since,
    until,
    effective_until: effectiveUntilClamped,
    timezone: TIMEZONE,
    bucket,
  };
  const recordedAtFrom = kstMidnight(since).toISOString();
  const recordedAtBefore = minTimestamp(kstMidnight(until), asOfDate).toISOString();

  return {
    range,
    recordedAtFrom,
    recordedAtBefore,
    empty: effectiveUntilClamped <= since || Date.parse(recordedAtFrom) >= Date.parse(recordedAtBefore),
  };
}

export function resolveSessionStatisticsDay(
  date: string,
  range: UsageStatsRange,
  asOf: string,
): SessionStatisticsDayRange {
  const selectedDate = parseCalendarDate(date, "day");
  const rangeSince = parseCalendarDate(range.since, "range.since");
  const rangeUntil = parseCalendarDate(range.effective_until, "range.effective_until");
  if (selectedDate < rangeSince || selectedDate >= rangeUntil) {
    throw new Error("session statistics day is outside the selected period");
  }

  const asOfDate = parseOffsetTimestamp(asOf, "asOf");
  const dayStart = kstMidnight(selectedDate);
  const dayEnd = kstMidnight(addDays(selectedDate, 1));
  return {
    recordedAtFrom: dayStart.toISOString(),
    recordedAtBefore: minTimestamp(dayEnd, asOfDate).toISOString(),
  };
}

export function parseOffsetTimestamp(value: string, label: string): Date {
  if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) {
    throw new Error(`session statistics ${label} must include a UTC offset`);
  }
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) {
    throw new Error(`session statistics ${label} is invalid`);
  }
  return timestamp;
}

function parseCalendarDate(value: string, label: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`session statistics ${label} must be YYYY-MM-DD`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`session statistics ${label} is invalid`);
  }
  return value;
}

function kstDate(value: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (year === undefined || month === undefined || day === undefined) {
    throw new Error("session statistics KST date could not be resolved");
  }
  return `${year}-${month}-${day}`;
}

function calendarDayOfWeek(date: string): number {
  return new Date(`${date}T00:00:00.000Z`).getUTCDay();
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function addMonths(date: string, months: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCMonth(value.getUTCMonth() + months);
  return value.toISOString().slice(0, 10);
}

function kstMidnight(date: string): Date {
  return new Date(`${date}T00:00:00.000+09:00`);
}

function minDate(left: string, right: string): string {
  return left < right ? left : right;
}

function minTimestamp(left: Date, right: Date): Date {
  return left.getTime() <= right.getTime() ? left : right;
}

/** Internal day seed; the public period union remains unchanged. */
export function resolveSessionStatisticsDateSlice(date: string, asOf: string): SessionStatisticsDayRange {
  const selected = parseCalendarDate(date, "day");
  const end = kstMidnight(addDays(selected, 1));
  return {
    recordedAtFrom: kstMidnight(selected).toISOString(),
    recordedAtBefore: minTimestamp(end, parseOffsetTimestamp(asOf, "asOf")).toISOString(),
  };
}
