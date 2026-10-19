// soul-app imports this source file directly. Keep it import-free and avoid
// destructuring/spread so Metro does not need to inject Babel runtime helpers.
export function formatUsageStatsTokenCount(value: number | null | undefined, compact = true): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "미기록";
  if (value === 0) return "0";
  if (compact) {
    return new Intl.NumberFormat("ko-KR", {
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(value);
  }
  return value.toLocaleString("en-US");
}

export function formatUsageStatsUsd(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "미확인";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

export function formatUsageStatsCoverage(
  pricedTokens: number | null | undefined,
  observedTokens: number | null | undefined,
): string {
  if (typeof pricedTokens !== "number" || !Number.isFinite(pricedTokens)) return "일부만 환산";
  if (typeof observedTokens !== "number" || !Number.isFinite(observedTokens) || observedTokens <= 0) {
    return "일부만 환산";
  }
  const percent = Math.round((pricedTokens / observedTokens) * 100);
  return `기록 토큰 ${percent}% 환산`;
}

export function formatUsageStatsPeriodLabel(
  period: "week" | "month" | "all",
  since: string,
  until: string,
): string {
  if (period === "month") return formatYearMonth(since);

  const untilDate = parseDate(until);
  const lastDate = formatDate(Date.UTC(untilDate.year, untilDate.month - 1, untilDate.day - 1));
  if (period === "week") {
    const start = parseDate(since);
    const end = parseDate(lastDate);
    if (start.year !== end.year) {
      return `${formatYearDate(since)} ~ ${formatYearDate(lastDate)}`;
    }
    if (start.month !== end.month) {
      return `${formatMonthDate(since)} ~ ${formatMonthDate(lastDate)}`;
    }
    return `${formatMonthDate(since)} ~ ${end.day}일`;
  }

  const first = parseDate(since);
  const last = parseDate(lastDate);
  if (first.year === last.year && first.month === last.month) return formatYearMonth(since);
  const firstLabel = formatYearMonth(since);
  const lastLabel = first.year === last.year ? `${last.month}월` : formatYearMonth(lastDate);
  return `${firstLabel} ~ ${lastLabel}`;
}

export function formatUsageStatsDateWithWeekday(date: string): string {
  const parsed = parseDate(date);
  const weekday = ["일", "월", "화", "수", "목", "금", "토"][
    new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day)).getUTCDay()
  ];
  return `${parsed.month}월 ${parsed.day}일 (${weekday})`;
}

export function shiftUsageStatsAnchor(
  period: "week" | "month" | "all",
  anchor: string,
  direction: number,
): string {
  const parsed = parseDate(anchor);
  if (period === "all" || !Number.isFinite(direction) || direction === 0) return anchor;
  if (period === "week") return formatDate(Date.UTC(parsed.year, parsed.month - 1, parsed.day + (direction < 0 ? -7 : 7)));

  const targetMonth = new Date(Date.UTC(parsed.year, parsed.month - 1 + (direction < 0 ? -1 : 1), 1));
  const year = targetMonth.getUTCFullYear();
  const month = targetMonth.getUTCMonth() + 1;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const day = Math.min(parsed.day, lastDay);
  return formatDate(Date.UTC(year, month - 1, day));
}

export function formatUsageStatsProviderLabel(provider: string): string {
  if (provider === "claude") return "Claude";
  if (provider === "codex") return "Codex";
  if (provider === "antigravity") return "Antigravity";
  if (provider === "deepseek") return "DeepSeek";
  if (provider === "kimi") return "Kimi";
  return provider;
}

export function formatUsageStatsModelLabel(model: string | null | undefined): string {
  if (!model) return "모델 미상";
  if (model === "claude-opus-5.5") return "Claude Opus 5.5";
  if (model === "claude-sonnet-5.5") return "Claude Sonnet 5.5";
  if (model === "gpt-6.1-sol") return "GPT-6.1 Sol";
  if (model === "gpt-6-luna") return "GPT-6 Luna";
  if (model === "gemini-3.8-flash") return "Gemini 3.8 Flash";
  if (model === "gemini-4-argon") return "Gemini 4 Argon";
  if (model === "kimi-for-coding/k3") return "Kimi for Coding K3";
  return model;
}

export function formatUsageStatsInputCategoryLabel(category: string): string {
  if (category === "system_prompt") return "시스템 프롬프트";
  if (category === "soulstream_injection") return "소울스트림 주입";
  if (category === "user_prompt") return "사용자 프롬프트";
  if (category === "tool_result") return "툴 결과";
  if (category === "harness_internal") return "하네스 내부 입력";
  return category;
}

function parseDate(value: string): { year: number; month: number; day: number } {
  const parts = value.split("-");
  return {
    year: Number(parts[0]),
    month: Number(parts[1]),
    day: Number(parts[2]),
  };
}

function formatDate(timestamp: number): string {
  const date = new Date(timestamp);
  return `${String(date.getUTCFullYear()).padStart(4, "0")}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function formatYearMonth(value: string): string {
  const date = parseDate(value);
  return `${date.year}년 ${date.month}월`;
}

function formatMonthDate(value: string): string {
  const date = parseDate(value);
  return `${date.month}월 ${date.day}일`;
}

function formatYearDate(value: string): string {
  const date = parseDate(value);
  return `${date.year}년 ${date.month}월 ${date.day}일`;
}
