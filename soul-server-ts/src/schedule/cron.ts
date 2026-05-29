type CronPart = {
  wildcard: boolean;
  values: Set<number>;
};

export interface ParsedCronExpression {
  minute: CronPart;
  hour: CronPart;
  dayOfMonth: CronPart;
  month: CronPart;
  dayOfWeek: CronPart;
}

const MINUTE_MS = 60_000;
const timezoneFormatters = new Map<string, Intl.DateTimeFormat>();

export function parseCronExpression(expression: string): ParsedCronExpression {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error("cron expression must have exactly 5 fields");
  }
  return {
    minute: parseCronPart(parts[0] ?? "", 0, 59),
    hour: parseCronPart(parts[1] ?? "", 0, 23),
    dayOfMonth: parseCronPart(parts[2] ?? "", 1, 31),
    month: parseCronPart(parts[3] ?? "", 1, 12),
    dayOfWeek: parseCronPart(parts[4] ?? "", 0, 7),
  };
}

export function nextCronRunAt(expression: string, after: Date, timezone = "UTC"): Date {
  const cron = parseCronExpression(expression);
  if (timezone !== "UTC") getTimezoneFormatter(timezone);
  const start = new Date(Math.floor(after.getTime() / MINUTE_MS) * MINUTE_MS + MINUTE_MS);
  const limit = start.getTime() + 366 * 24 * 60 * MINUTE_MS;
  for (let t = start.getTime(); t <= limit; t += MINUTE_MS) {
    const candidate = new Date(t);
    if (matchesCron(cron, candidate, timezone)) return candidate;
  }
  throw new Error("cron expression did not match within one year");
}

export function matchesCron(
  cron: ParsedCronExpression,
  date: Date,
  timezone = "UTC",
): boolean {
  const parts = timezone === "UTC" ? utcParts(date) : timezoneParts(date, timezone);
  if (!cron.minute.values.has(parts.minute)) return false;
  if (!cron.hour.values.has(parts.hour)) return false;
  if (!cron.month.values.has(parts.month)) return false;

  const domMatches = cron.dayOfMonth.values.has(parts.dayOfMonth);
  const rawDow = parts.dayOfWeek;
  const dowMatches = cron.dayOfWeek.values.has(rawDow)
    || (rawDow === 0 && cron.dayOfWeek.values.has(7));

  if (cron.dayOfMonth.wildcard && cron.dayOfWeek.wildcard) return true;
  if (cron.dayOfMonth.wildcard) return dowMatches;
  if (cron.dayOfWeek.wildcard) return domMatches;
  return domMatches || dowMatches;
}

function parseCronPart(raw: string, min: number, max: number): CronPart {
  const values = new Set<number>();
  const wildcard = raw === "*";
  for (const token of raw.split(",")) {
    addCronToken(values, token, min, max);
  }
  if (values.size === 0) {
    throw new Error(`empty cron field: ${raw}`);
  }
  return { wildcard, values };
}

function addCronToken(values: Set<number>, token: string, min: number, max: number): void {
  if (!token) throw new Error("empty cron token");
  const [rangeToken, stepToken] = token.split("/");
  const step = stepToken === undefined ? 1 : parsePositiveInt(stepToken, "cron step");
  if (step < 1) throw new Error("cron step must be >= 1");

  let start: number;
  let end: number;
  if (rangeToken === "*") {
    start = min;
    end = max;
  } else if (rangeToken?.includes("-")) {
    const [startRaw, endRaw] = rangeToken.split("-");
    start = parseCronNumber(startRaw ?? "", min, max);
    end = parseCronNumber(endRaw ?? "", min, max);
    if (end < start) throw new Error(`invalid cron range: ${rangeToken}`);
  } else {
    start = parseCronNumber(rangeToken ?? "", min, max);
    end = start;
  }

  for (let value = start; value <= end; value += step) {
    values.add(value);
  }
}

function parseCronNumber(raw: string, min: number, max: number): number {
  const value = parsePositiveInt(raw, "cron value");
  if (value < min || value > max) {
    throw new Error(`cron value ${value} outside range ${min}-${max}`);
  }
  return value;
}

function parsePositiveInt(raw: string | undefined, label: string): number {
  if (!raw || !/^\d+$/.test(raw)) {
    throw new Error(`${label} must be an integer`);
  }
  return Number.parseInt(raw, 10);
}

function utcParts(date: Date): {
  minute: number;
  hour: number;
  dayOfMonth: number;
  month: number;
  dayOfWeek: number;
} {
  return {
    minute: date.getUTCMinutes(),
    hour: date.getUTCHours(),
    dayOfMonth: date.getUTCDate(),
    month: date.getUTCMonth() + 1,
    dayOfWeek: date.getUTCDay(),
  };
}

function timezoneParts(date: Date, timezone: string): {
  minute: number;
  hour: number;
  dayOfMonth: number;
  month: number;
  dayOfWeek: number;
} {
  const raw: Record<string, number> = {};
  for (const part of getTimezoneFormatter(timezone).formatToParts(date)) {
    if (
      part.type === "year" ||
      part.type === "month" ||
      part.type === "day" ||
      part.type === "hour" ||
      part.type === "minute"
    ) {
      raw[part.type] = Number.parseInt(part.value, 10);
    }
  }
  const year = requiredPart(raw, "year", timezone);
  const month = requiredPart(raw, "month", timezone);
  const dayOfMonth = requiredPart(raw, "day", timezone);
  return {
    minute: requiredPart(raw, "minute", timezone),
    hour: requiredPart(raw, "hour", timezone),
    dayOfMonth,
    month,
    dayOfWeek: new Date(Date.UTC(year, month - 1, dayOfMonth)).getUTCDay(),
  };
}

function getTimezoneFormatter(timezone: string): Intl.DateTimeFormat {
  const existing = timezoneFormatters.get(timezone);
  if (existing) return existing;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  });
  timezoneFormatters.set(timezone, formatter);
  return formatter;
}

function requiredPart(
  parts: Record<string, number>,
  name: string,
  timezone: string,
): number {
  const value = parts[name];
  if (value === undefined || Number.isNaN(value)) {
    throw new Error(`timezone ${timezone} did not produce ${name}`);
  }
  return value;
}
