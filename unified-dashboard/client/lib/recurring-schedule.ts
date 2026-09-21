export type RecurringScheduleMode = "daily" | "weekdays" | "weekly" | "monthly" | "advanced";

export type RecurringScheduleDraft = {
  mode: RecurringScheduleMode;
  times: string[];
  weekdays: number[];
  monthDays: number[];
  advancedExpressions: string;
};

export function defaultRecurringSchedule(): RecurringScheduleDraft {
  return {
    mode: "weekdays",
    times: ["09:00"],
    weekdays: [1, 2, 3, 4, 5],
    monthDays: [1],
    advancedExpressions: "0 9 * * 1-5",
  };
}

export function recurringScheduleFromExpressions(
  expressions: readonly string[],
): RecurringScheduleDraft {
  const normalized = expressions.map((value) => value.trim()).filter(Boolean);
  const parsed = normalized.map(parseStructuredExpression);
  if (normalized.length === 0 || parsed.some((value) => value === null)) {
    return advancedSchedule(normalized);
  }
  const values = parsed as ParsedExpression[];
  const [first] = values;
  if (!first || values.some((value) => value.day !== first.day || value.weekday !== first.weekday)) {
    return advancedSchedule(normalized);
  }
  const times = values.map((value) => value.time);
  if (first.day === "*" && first.weekday === "*") {
    return { ...defaultRecurringSchedule(), mode: "daily", times, advancedExpressions: normalized.join("\n") };
  }
  if (first.day === "*" && first.weekday === "1-5") {
    return { ...defaultRecurringSchedule(), mode: "weekdays", times, advancedExpressions: normalized.join("\n") };
  }
  if (first.day === "*" && /^\d(?:,\d)*$/.test(first.weekday)) {
    return {
      ...defaultRecurringSchedule(),
      mode: "weekly",
      times,
      weekdays: first.weekday.split(",").map(Number),
      advancedExpressions: normalized.join("\n"),
    };
  }
  if (/^\d{1,2}(?:,\d{1,2})*$/.test(first.day) && first.weekday === "*") {
    return {
      ...defaultRecurringSchedule(),
      mode: "monthly",
      times,
      monthDays: first.day.split(",").map(Number),
      advancedExpressions: normalized.join("\n"),
    };
  }
  return advancedSchedule(normalized);
}

export function recurringScheduleExpressions(schedule: RecurringScheduleDraft): string[] {
  if (schedule.mode === "advanced") return splitExpressions(schedule.advancedExpressions);
  const times = [...new Set(schedule.times.map(normalizeTime))];
  if (times.length === 0) throw new Error("실행 시각을 하나 이상 선택해야 합니다.");
  const weekdays = uniqueNumbers(schedule.weekdays, 0, 6);
  const monthDays = uniqueNumbers(schedule.monthDays, 1, 31);
  const day = schedule.mode === "monthly"
    ? requiredList(monthDays, "매월 날짜").join(",")
    : "*";
  const weekday = schedule.mode === "daily"
    ? "*"
    : schedule.mode === "weekdays"
      ? "1-5"
      : schedule.mode === "weekly"
        ? requiredList(weekdays, "요일").join(",")
        : "*";
  return times.map((time) => {
    const [hour, minute] = time.split(":");
    return `${Number(minute)} ${Number(hour)} ${day} * ${weekday}`;
  });
}

function advancedSchedule(expressions: readonly string[]): RecurringScheduleDraft {
  return { ...defaultRecurringSchedule(), mode: "advanced", advancedExpressions: expressions.join("\n") };
}

type ParsedExpression = { time: string; day: string; weekday: string };

function parseStructuredExpression(value: string): ParsedExpression | null {
  const match = /^(\d{1,2})\s+(\d{1,2})\s+(\*|\d{1,2}(?:,\d{1,2})*)\s+\*\s+(\*|1-5|\d(?:,\d)*)$/.exec(value);
  if (!match) return null;
  const minute = Number(match[1]);
  const hour = Number(match[2]);
  if (minute > 59 || hour > 23) return null;
  return { time: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`, day: match[3]!, weekday: match[4]! };
}

function normalizeTime(value: string): string {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) throw new Error("실행 시각은 HH:MM 형식이어야 합니다.");
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error("실행 시각이 올바르지 않습니다.");
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function uniqueNumbers(values: readonly number[], min: number, max: number): number[] {
  return [...new Set(values.filter((value) => Number.isInteger(value) && value >= min && value <= max))]
    .sort((left, right) => left - right);
}

function requiredList(values: readonly number[], label: string): readonly number[] {
  if (values.length === 0) throw new Error(`${label}을 하나 이상 선택해야 합니다.`);
  return values;
}

function splitExpressions(value: string): string[] {
  const expressions = value.split("\n").map((item) => item.trim()).filter(Boolean);
  if (expressions.length === 0) throw new Error("고급 cron을 하나 이상 입력해야 합니다.");
  return expressions;
}
