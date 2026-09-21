type CronField = {
  readonly matches: (value: number) => boolean;
  readonly wildcard: boolean;
};

type CronExpression = {
  readonly source: string;
  readonly minute: CronField;
  readonly hour: CronField;
  readonly dayOfMonth: CronField;
  readonly month: CronField;
  readonly dayOfWeek: CronField;
};

export type RecurringScheduleInput = {
  readonly timezone: string;
  readonly scheduleExpressions: readonly string[];
};

export type CompiledRecurringSchedule = {
  readonly timezone: string;
  /** Canonical five-field strings. Input order remains meaningful to callers. */
  readonly scheduleExpressions: readonly string[];
  readonly expressions: readonly CronExpression[];
};

type LocalMinute = {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly dayOfWeek: number;
  readonly stamp: string;
};

const MAX_SEARCH_MINUTES = 3 * 366 * 24 * 60;
const FALLBACK_HISTORY_MS = 26 * 60 * 60 * 1_000;

export function compileRecurringSchedule(
  input: RecurringScheduleInput,
): CompiledRecurringSchedule {
  const timezone = input.timezone.trim();
  if (!timezone) throw new Error("timezone is required");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
  } catch {
    throw new Error(`invalid timezone: ${input.timezone}`);
  }
  if (input.scheduleExpressions.length === 0) {
    throw new Error("at least one schedule expression is required");
  }
  const scheduleExpressions = input.scheduleExpressions.map((expression) =>
    normalizeExpression(expression),
  );
  return {
    timezone,
    scheduleExpressions,
    expressions: scheduleExpressions.map(parseExpression),
  };
}

/**
 * Returns instants strictly after `after`. The cursor starts one day earlier so
 * a repeated fall-back local minute is remembered even when its first instant
 * was already in the past. Each cron expression gets its own local-minute
 * fence, then all expressions are deduplicated by absolute minute.
 */
export function nextRecurringOccurrences(
  schedule: CompiledRecurringSchedule,
  after: Date,
  count: number,
): Date[] {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error("count must be a positive integer");
  }
  if (!Number.isFinite(after.getTime())) throw new Error("after must be a valid date");

  const formatter = localMinuteFormatter(schedule.timezone);
  const afterMs = after.getTime();
  let cursorMs = floorMinute(afterMs - FALLBACK_HISTORY_MS);
  const seenLocalMinutes = schedule.expressions.map(() => new Set<string>());
  const result = new Map<number, Date>();

  for (let scanned = 0; scanned < MAX_SEARCH_MINUTES; scanned += 1) {
    const local = toLocalMinute(new Date(cursorMs), formatter);
    for (let index = 0; index < schedule.expressions.length; index += 1) {
      const expression = schedule.expressions[index];
      const seen = seenLocalMinutes[index];
      if (!expression || !seen) throw new Error("compiled recurring schedule is incomplete");
      if (!matches(expression, local)) continue;
      if (seen.has(local.stamp)) continue;
      seen.add(local.stamp);
      if (cursorMs > afterMs) result.set(cursorMs, new Date(cursorMs));
    }
    if (result.size >= count) {
      return [...result.values()]
        .sort((left, right) => left.getTime() - right.getTime())
        .slice(0, count);
    }
    cursorMs += 60_000;
  }
  throw new Error("could not find a future occurrence within three years");
}

function normalizeExpression(expression: string): string {
  if (typeof expression !== "string") throw new Error("cron expression must be a string");
  const normalized = expression.trim().replace(/\s+/g, " ");
  if (!normalized) throw new Error("cron expression must not be empty");
  return normalized;
}

function parseExpression(source: string): CronExpression {
  const fields = source.split(" ");
  if (fields.length !== 5) throw new Error(`cron expression must have five fields: ${source}`);
  return {
    source,
    minute: parseField(requiredField(fields, 0), 0, 59, "minute"),
    hour: parseField(requiredField(fields, 1), 0, 23, "hour"),
    dayOfMonth: parseField(requiredField(fields, 2), 1, 31, "day of month"),
    month: parseField(requiredField(fields, 3), 1, 12, "month"),
    dayOfWeek: parseField(requiredField(fields, 4), 0, 7, "day of week", true),
  };
}

function parseField(
  source: string,
  minimum: number,
  maximum: number,
  label: string,
  normalizeSunday = false,
): CronField {
  const values = new Set<number>();
  const wildcard = source === "*";
  for (const part of source.split(",")) {
    const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!match) throw new Error(`invalid ${label} field: ${source}`);
    const step = match[2] === undefined ? 1 : Number(match[2]);
    if (!Number.isInteger(step) || step < 1) throw new Error(`invalid ${label} step: ${source}`);
    const rangeSource = match[1];
    if (!rangeSource) throw new Error(`invalid ${label} field: ${source}`);
    const range = rangeSource === "*"
      ? [minimum, maximum] as const
      : numericRange(rangeSource, minimum, maximum, label);
    for (let value = range[0]; value <= range[1]; value += step) {
      values.add(normalizeSunday && value === 7 ? 0 : value);
    }
  }
  return { wildcard, matches: (value) => values.has(value) };
}

function numericRange(
  source: string,
  minimum: number,
  maximum: number,
  label: string,
): readonly [number, number] {
  const [startRaw, endRaw] = source.split("-");
  if (startRaw === undefined) throw new Error(`invalid ${label} range: ${source}`);
  const start = Number(startRaw);
  const end = endRaw === undefined ? start : Number(endRaw);
  if (!Number.isInteger(start) || !Number.isInteger(end) ||
      start < minimum || end > maximum || start > end) {
    throw new Error(`invalid ${label} range: ${source}`);
  }
  return [start, end];
}

function requiredField(fields: readonly string[], index: number): string {
  const field = fields[index];
  if (field === undefined) throw new Error("cron expression must have five fields");
  return field;
}

function matches(expression: CronExpression, local: LocalMinute): boolean {
  if (!expression.minute.matches(local.minute) ||
      !expression.hour.matches(local.hour) ||
      !expression.month.matches(local.month)) {
    return false;
  }
  const dayOfMonthMatches = expression.dayOfMonth.matches(local.day);
  const dayOfWeekMatches = expression.dayOfWeek.matches(local.dayOfWeek);
  const dayMatches = expression.dayOfMonth.wildcard
    ? dayOfWeekMatches
    : expression.dayOfWeek.wildcard
      ? dayOfMonthMatches
      : dayOfMonthMatches || dayOfWeekMatches;
  return dayMatches;
}

function localMinuteFormatter(timezone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-US-u-ca-gregory", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  });
}

function toLocalMinute(date: Date, formatter: Intl.DateTimeFormat): LocalMinute {
  const values = Object.fromEntries(
    formatter.formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  const year = numberPart(values.year, "year");
  const month = numberPart(values.month, "month");
  const day = numberPart(values.day, "day");
  const hour = numberPart(values.hour, "hour");
  const minute = numberPart(values.minute, "minute");
  const weekday = weekdayNumber(values.weekday);
  return {
    year,
    month,
    day,
    hour,
    minute,
    dayOfWeek: weekday,
    stamp: `${year}-${month}-${day}-${hour}-${minute}`,
  };
}

function numberPart(value: string | undefined, label: string): number {
  const numeric = Number(value);
  if (!Number.isInteger(numeric)) throw new Error(`Intl did not produce ${label}`);
  return numeric;
}

function weekdayNumber(value: string | undefined): number {
  const days: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  const day = value ? days[value] : undefined;
  if (day === undefined) throw new Error("Intl did not produce a weekday");
  return day;
}

function floorMinute(milliseconds: number): number {
  return Math.floor(milliseconds / 60_000) * 60_000;
}
