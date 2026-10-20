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
  denominatorPartial = false,
): string {
  if (typeof observedTokens !== "number" || !Number.isFinite(observedTokens) || observedTokens <= 0) return "";
  if (denominatorPartial) return "일부만 환산";
  if (typeof pricedTokens !== "number" || !Number.isFinite(pricedTokens) || pricedTokens < 0 || pricedTokens > observedTokens) return "일부만 환산";
  const percent = Math.round((pricedTokens / observedTokens) * 100);
  return `기록 토큰 ${percent}% 환산`;
}

export const USAGE_STATS_LABELS = {
  tokenDetails: "토큰 상세",
  missingUsage: "미기록", unknownPrice: "정가 미확인", unknownCost: "미확인",
  nonCacheCost: "비캐시", cacheReadCost: "캐시 읽기",
  cacheReadExcludedRule: "캐시 읽기 제외", uncachedInput: "그중 일반 입력",
  cacheReadToggleGroup: "캐시 읽기", cacheReadExclude: "캐시 제외", cacheReadInclude: "캐시 포함",
  beforeCoverage: "이 기간은 기록 전입니다", emptyRange: "이 기간에 기록이 없습니다",
  missingInput: "일부 세션 미기록",
  inputEstimateBasis: "저장된 manifest 추정값을 우선하며, 없으면 기록된 자료의 글자 수를 4로 나눈 올림값을 사용합니다.",
  inputEstimateCaveat: "언어와 모델에 따라 실제 토큰과 차이가 있습니다. 입력 구성은 관측 자료 기준이며 실측 과금 토큰과 분모가 다릅니다.",
  input: "입력 (캐시 포함)", cacheRead: "그중 캐시 읽기", cacheWrite: "그중 캐시 쓰기",
  output: "출력", reasoning: "그중 추론",
};

export function formatUsageStatsApproximateTokens(value: number | null, observed = false, partial = false): string {
  if (value === null) return observed ? "관측 안 됨" : "미기록";
  if (partial && value === 0) return "미기록";
  return `${observed ? "추정 " : ""}약 ${value.toLocaleString("ko-KR")}${partial ? "+" : ""} 토큰`;
}

export function formatUsageStatsValue(
  metrics: {
    total_tokens: number | null;
    provider_total_tokens: number | null;
    reference_cost_usd: number | null;
    reference_cost_breakdown?: {
      non_cache: { known_cost_usd: number | null; is_partial: boolean };
    };
  },
  coverage: {
    usage_partial_events: number;
    missing_usage_turns: number;
    unknown_total_token_events: number;
    unpriced_events: number;
    unattributed_missing_usage: boolean;
    token_partials: {
      total_tokens: boolean;
      provider_total_tokens: boolean;
      ordinary_input: boolean;
      cache_read: boolean;
    };
  },
  metric: "tokens" | "cost", row = false, includeCacheRead = false,
): string {
  if (metric === "tokens") {
    const value = includeCacheRead ? metrics.provider_total_tokens : metrics.total_tokens;
    const partial = includeCacheRead
      ? coverage.token_partials.provider_total_tokens
      : coverage.token_partials.total_tokens;
    if (value === null || (value === 0 && partial)) return USAGE_STATS_LABELS.missingUsage;
    return `${formatUsageStatsTokenCount(value)}${partial ? "+" : ""}`;
  }
  // Calls predating the option retain their total-cost output; explicit false selects the non-cache component.
  if (!includeCacheRead && arguments.length >= 5) {
    if (!metrics.reference_cost_breakdown) return USAGE_STATS_LABELS.unknownCost;
    return formatUsageStatsSplitCost(metrics.reference_cost_breakdown.non_cache);
  }
  const partial = isUsageStatsCostPartial(coverage);
  if (row && metrics.provider_total_tokens === null) return USAGE_STATS_LABELS.missingUsage;
  if (metrics.reference_cost_usd === null || (metrics.reference_cost_usd === 0 && partial)) return row ? USAGE_STATS_LABELS.unknownPrice : USAGE_STATS_LABELS.unknownCost;
  return `${formatUsageStatsUsd(metrics.reference_cost_usd)}${partial ? "+" : ""}`;
}

export function usageStatsMetricValue(
  metrics: {
    total_tokens: number | null;
    provider_total_tokens: number | null;
    reference_cost_usd: number | null;
    reference_cost_breakdown: {
      non_cache: { known_cost_usd: number | null; is_partial: boolean };
    };
  },
  metric: "tokens" | "cost",
  includeCacheRead: boolean,
): number | null {
  if (metric === "tokens") return includeCacheRead ? metrics.provider_total_tokens : metrics.total_tokens;
  return includeCacheRead
    ? metrics.reference_cost_usd
    : metrics.reference_cost_breakdown.non_cache.known_cost_usd;
}

export function formatUsageStatsCacheSplit(
  metrics: {
    cache_read: number | null;
    ordinary_input: number | null;
    reference_cost_breakdown: {
      cache_read: { known_cost_usd: number | null; is_partial: boolean };
      non_cache: { known_cost_usd: number | null; is_partial: boolean };
    };
  } | null | undefined,
  coverage: {
    token_partials: {
      total_tokens: boolean;
      provider_total_tokens: boolean;
      ordinary_input: boolean;
      cache_read: boolean;
    };
  } | null | undefined,
): { cacheReadLine: string; nonCacheCost: string; cacheReadCost: string; ordinaryInput: string } {
  if (!metrics || !coverage) {
    return {
      cacheReadLine: USAGE_STATS_LABELS.cacheReadExcludedRule,
      nonCacheCost: "",
      cacheReadCost: "",
      ordinaryInput: "",
    };
  }
  const tokenPartials = coverage.token_partials;
  const cacheReadPartial = tokenPartials.cache_read;
  let cacheReadLine = `${USAGE_STATS_LABELS.cacheReadCost} ${USAGE_STATS_LABELS.missingUsage}`;
  if (metrics.cache_read !== null && !(metrics.cache_read === 0 && cacheReadPartial)) {
    cacheReadLine = `${USAGE_STATS_LABELS.cacheReadCost} ${formatUsageStatsTokenCount(metrics.cache_read)}${cacheReadPartial ? "+" : ""} 제외`;
  }
  let ordinaryInput = USAGE_STATS_LABELS.missingUsage;
  if (metrics.ordinary_input !== null && !(metrics.ordinary_input === 0 && tokenPartials.ordinary_input)) {
    ordinaryInput = `${formatUsageStatsTokenCount(metrics.ordinary_input, false)}${tokenPartials.ordinary_input ? "+" : ""}`;
  }
  return {
    cacheReadLine,
    nonCacheCost: formatUsageStatsSplitCost(metrics.reference_cost_breakdown.non_cache),
    cacheReadCost: formatUsageStatsSplitCost(metrics.reference_cost_breakdown.cache_read),
    ordinaryInput,
  };
}

function formatUsageStatsSplitCost(component: { known_cost_usd: number | null; is_partial: boolean }): string {
  if (component.known_cost_usd === null || (component.known_cost_usd === 0 && component.is_partial)) {
    return USAGE_STATS_LABELS.unknownCost;
  }
  return `${formatUsageStatsUsd(component.known_cost_usd)}${component.is_partial ? "+" : ""}`;
}

export function usageStatsModelColorIndex(model: string | null | undefined, roster: readonly (string | null)[]): number {
  if (!model) return -1;
  const index = roster.indexOf(model);
  return index < 5 ? index : -1;
}

export function usageStatsMonthAnchor(bucket: string, asOf: string): string {
  const parsed = parseDate(bucket);
  const monthEnd = formatDate(Date.UTC(parsed.year, parsed.month, 0));
  const today = usageStatsKstDate(asOf);
  return monthEnd < today ? monthEnd : today;
}

// Fixture/legacy pure helper only. Production must consume the server's range instead of rebuilding it here.
export function usageStatsRange(period: "week" | "month" | "all", anchor: string, asOf: string, coveredSince: string) {
  const today = usageStatsKstDate(asOf);
  const todayEnd = addDays(today, 1);
  let since = coveredSince;
  let until = todayEnd;
  let bucket: "day" | "month" = "month";
  if (period !== "all") {
    const calendar = usageStatsCalendarRange(period, anchor);
    since = calendar.since;
    until = calendar.until;
    bucket = "day";
  }
  const effective = until < todayEnd ? until : todayEnd;
  return { period, since, until, effective_until: effective < since ? since : effective, timezone: "Asia/Seoul" as const, bucket };
}

export function usageStatsKstDate(instant: string | number): string {
  const date = typeof instant === "number" ? new Date(instant) : new Date(instant);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  let year = "";
  let month = "";
  let day = "";
  for (const part of parts) {
    if (part.type === "year") year = part.value;
    else if (part.type === "month") month = part.value;
    else if (part.type === "day") day = part.value;
  }
  return `${year}-${month}-${day}`;
}

export function usageStatsCalendarRange(period: "week" | "month", anchor: string): {
  since: string;
  until: string;
  bucket: "day";
} {
  const parsed = parseDate(anchor);
  if (period === "week") {
    const weekday = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day)).getUTCDay();
    const since = formatDate(Date.UTC(parsed.year, parsed.month - 1, parsed.day - ((weekday + 6) % 7)));
    const start = parseDate(since);
    return { since, until: formatDate(Date.UTC(start.year, start.month - 1, start.day + 7)), bucket: "day" };
  }
  return {
    since: formatDate(Date.UTC(parsed.year, parsed.month - 1, 1)),
    until: formatDate(Date.UTC(parsed.year, parsed.month, 1)),
    bucket: "day",
  };
}

export function usageStatsBucketStarts(range: {
  since: string;
  until: string;
  effective_until: string;
  bucket: "day" | "month";
}): string[] {
  const buckets: string[] = [];
  if (range.bucket === "day") {
    let cursor = range.since;
    while (cursor < range.until) {
      buckets.push(cursor);
      cursor = addDays(cursor, 1);
    }
    return buckets;
  }
  const start = parseDate(range.since);
  let year = start.year;
  let month = start.month;
  let cursor = formatDate(Date.UTC(year, month - 1, 1));
  while (cursor < range.effective_until) {
    buckets.push(cursor);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
    cursor = formatDate(Date.UTC(year, month - 1, 1));
  }
  return buckets;
}

function addDays(date: string, amount: number): string {
  const parsed = parseDate(date);
  return formatDate(Date.UTC(parsed.year, parsed.month - 1, parsed.day + amount));
}

export function isUsageStatsTokenPartial(coverage: {
  token_partials: {
    total_tokens: boolean;
    provider_total_tokens: boolean;
    ordinary_input: boolean;
    cache_read: boolean;
  };
}): boolean {
  return coverage.token_partials.total_tokens;
}

export function isUsageStatsCostPartial(coverage: {
  unpriced_events: number;
  token_partials: {
    total_tokens: boolean;
    provider_total_tokens: boolean;
    ordinary_input: boolean;
    cache_read: boolean;
  };
}): boolean {
  return coverage.unpriced_events > 0 || coverage.token_partials.provider_total_tokens;
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
  if (provider === "unknown") return "공급자 미확인";
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
  if (category === "history_replay") return "이전 대화 재전달";
  if (category === "tool_definition") return "툴 정의";
  if (category === "framing") return "구분자·형식";
  if (category === "combined_visible") return "합쳐진 입력 자료";
  if (category === "unknown") return "분류 미확인";
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
