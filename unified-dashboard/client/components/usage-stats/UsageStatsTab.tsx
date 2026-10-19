import { useEffect, useMemo, useState } from "react";
import {
  Button,
  DashboardIconCap,
  formatUsageStatsCoverage,
  formatUsageStatsDateWithWeekday,
  formatUsageStatsInputCategoryLabel,
  formatUsageStatsModelLabel,
  formatUsageStatsPeriodLabel,
  formatUsageStatsProviderLabel,
  formatUsageStatsTokenCount,
  formatUsageStatsUsd,
  formatUsageStatsValue,
  formatUsageStatsChars,
  USAGE_STATS_LABELS,
  usageStatsMonthAnchor,
  usageStatsModelColorIndex,
  shiftUsageStatsAnchor,
  USAGE_STATS_FIXTURE_ANCHOR,
  type UsageStatsAggregate,
  type UsageStatsDayDetail,
  type UsageStatsMetrics,
  type UsageStatsOverview,
  type UsageStatsProjectRow,
  type UsageStatsProvider,
  type UsageStatsProviderRow,
  type UsageStatsRange,
  type UsageStatsSeriesPoint,
  type UsageStatsPeriod,
} from "@seosoyoung/soul-ui";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { CatalogSelectionField } from "../CatalogSelectionField";
import { SettingsAlert, SettingsGroupBox } from "../config/SettingsListDetail";
import { UsageShareRow } from "./UsageShareRow";
import { UsageStackedBars, type UsageChartSeries } from "./UsageStackedBars";
import "./usage-stats.css";

type LoadState = "loading" | "ready" | "error" | "forbidden";
type Metric = "tokens" | "cost";
const API_URL = "/api/session-statistics";

function makeQuery(period: UsageStatsPeriod, anchor: string, provider: UsageStatsProvider | null, projectId: string | null): URLSearchParams {
  const params = new URLSearchParams({ period, anchor, timezone: "Asia/Seoul" });
  if (provider) params.set("provider", provider);
  if (projectId) params.set("project_ids", projectId);
  return params;
}

function fallbackRange(period: UsageStatsPeriod, anchor: string): UsageStatsRange {
  const parsed = new Date(`${anchor}T00:00:00Z`);
  let since = "2026-09-01";
  let until = "2026-10-19";
  let bucket: UsageStatsRange["bucket"] = "month";
  if (period === "week") {
    const monday = new Date(parsed);
    monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
    since = monday.toISOString().slice(0, 10);
    const next = new Date(monday);
    next.setUTCDate(next.getUTCDate() + 7);
    until = next.toISOString().slice(0, 10);
    bucket = "day";
  } else if (period === "month") {
    since = `${anchor.slice(0, 7)}-01`;
    const first = new Date(`${since}T00:00:00Z`);
    first.setUTCMonth(first.getUTCMonth() + 1);
    until = first.toISOString().slice(0, 10);
    bucket = "day";
  }
  const effectiveUntil = period === "all" ? until : (until < "2026-10-19" ? until : "2026-10-19");
  return { period, since, until, effective_until: effectiveUntil, timezone: "Asia/Seoul", bucket };
}

function metricValue(metrics: UsageStatsMetrics, metric: Metric): number | null {
  return metric === "tokens" ? metrics.total_tokens : metrics.reference_cost_usd;
}

function isAggregateActive(aggregate: UsageStatsAggregate | null): boolean {
  if (!aggregate) return false;
  const { metrics, coverage } = aggregate;
  return (metrics.total_tokens ?? 0) > 0 || coverage.usage_complete_events > 0 || coverage.usage_partial_events > 0 ||
    coverage.missing_usage_turns > 0 || coverage.pending_inputs > 0 || coverage.unpriced_events > 0 || coverage.unknown_total_token_events > 0;
}

function valueForMetric(
  metrics: UsageStatsMetrics,
  metric: Metric,
  partial: boolean,
  coverage: UsageStatsAggregate["coverage"],
  row = false,
): string {
  return formatUsageStatsValue(metrics, coverage, metric, row);
}

function shareFor(value: number | null, total: number): number | null {
  return value === null ? null : total > 0 ? value / total : value === 0 ? 0 : null;
}

function providerColor(provider: string): string {
  return `var(--usage-stats-provider-${provider})`;
}

function projectColor(index: number): string {
  return index >= 0 && index < 5 ? `var(--usage-stats-project-${index + 1})` : "var(--v3-text-tertiary)";
}

function providerSeries(rows: readonly UsageStatsProviderRow[], provider: UsageStatsProvider | null, roster: readonly (string | null)[]): UsageChartSeries[] {
  return rows.map(row => ({
    key: provider ? `${row.provider}:${row.model ?? "__unknown__"}` : row.provider,
    label: row.model ? formatUsageStatsModelLabel(row.model) : formatUsageStatsProviderLabel(row.provider),
    color: provider ? projectColor(usageStatsModelColorIndex(row.model, roster)) : providerColor(row.provider),
  }));
}

function projectSeries(rows: readonly UsageStatsProjectRow[]): UsageChartSeries[] {
  return rows.map((row, index) => ({
    key: row.project_id ?? "__unclassified__",
    label: row.label,
    color: row.project_id === null || row.project_id === "__other__" ? "var(--v3-text-tertiary)" : projectColor(index),
  }));
}

function providerPointKey(point: UsageStatsSeriesPoint, provider: UsageStatsProvider | null): string {
  return provider ? `${point.provider ?? "__unknown__"}:${point.model ?? "__unknown__"}` : point.provider ?? "__unknown__";
}

function metricTotal(rows: readonly { metrics: UsageStatsMetrics }[], metric: Metric): number {
  let total = 0;
  for (const row of rows) {
    const value = metricValue(row.metrics, metric);
    if (value !== null) total += value;
  }
  return total;
}

function PeriodButtons({ value, onChange, label }: { value: string; onChange(value: string): void; label: string }) {
  const options = [{ value: "week", label: "주간" }, { value: "month", label: "월간" }, { value: "all", label: "전체" }];
  return <div className="v3-completed-periods" role="group" aria-label={label}>
    {options.map(option => <Button key={option.value} size="sm" variant="ghost" aria-pressed={value === option.value} onClick={() => onChange(option.value)}>{option.label}</Button>)}
  </div>;
}

export function UsageStatsTab({ request = fetch }: { request?: typeof fetch } = {}) {
  const [period, setPeriod] = useState<UsageStatsPeriod>("week");
  const [anchor, setAnchor] = useState(USAGE_STATS_FIXTURE_ANCHOR);
  const [provider, setProvider] = useState<UsageStatsProvider | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [metric, setMetric] = useState<Metric>("tokens");
  const [overview, setOverview] = useState<UsageStatsOverview | null>(null);
  const [periodModelRoster, setPeriodModelRoster] = useState<(string | null)[]>([]);
  const [detail, setDetail] = useState<UsageStatsDayDetail | null>(null);
  const [detailDate, setDetailDate] = useState<string | null>(null);
  const [state, setState] = useState<LoadState>("loading");
  const [retry, setRetry] = useState(0);

  const requester = request ?? fetch;
  const range = state === "ready" && overview ? overview.range : fallbackRange(period, anchor);
  const coveredSince = overview?.projection_status.covered_since ?? range.since;
  const providerOptions = useMemo(() => [
    { value: "all", label: "모든 모델" },
    { value: "claude", label: "Claude" },
    { value: "codex", label: "Codex" },
    { value: "antigravity", label: "Antigravity" },
    { value: "deepseek", label: "DeepSeek" },
    { value: "kimi", label: "Kimi" },
  ], []);
  const projectOptions = useMemo(() => [
    { value: "all", label: "모든 프로젝트" },
    ...(overview?.by_project ?? [])
      .filter(row => row.project_id !== "__other__")
      .map(row => ({ value: row.project_id ?? "__unclassified__", label: row.label })),
  ], [overview?.by_project]);
  const selectedProjectLabel = projectOptions.find(option => option.value === (projectId ?? "all"))?.label ?? "모든 프로젝트";
  const projectRoster = useMemo(() => (overview?.by_project ?? [])
    .flatMap(row => row.project_id && row.project_id !== "__other__" ? [row.project_id] : []), [overview?.by_project]);
  const projectRosterKey = projectRoster.join(",");

  useEffect(() => {
    let active = true;
    setState("loading");
    setDetail(null);
    setDetailDate(null);
    const params = makeQuery(period, anchor, provider, projectId);
    const readOverview = async (query: URLSearchParams) => {
      const response = await requester(`${API_URL}?${query.toString()}`, { credentials: "same-origin" });
      if (response.status === 403) throw Object.assign(new Error("forbidden"), { status: 403 });
      if (!response.ok) throw new Error(`조회 실패: ${response.status}`);
      return response.json() as Promise<UsageStatsOverview>;
    };
    const current = readOverview(params);
    void Promise.all([current, provider && projectId ? readOverview(makeQuery(period, anchor, provider, null)) : current])
      .then(([data, unfiltered]) => {
        if (!active) return;
        setOverview(data);
        setPeriodModelRoster(unfiltered.by_model.map(row => row.model));
        setState("ready");
      })
      .catch((error: unknown) => {
        if (!active) return;
        setOverview(null);
        setState(typeof error === "object" && error !== null && "status" in error && error.status === 403 ? "forbidden" : "error");
      });
    return () => { active = false; };
  }, [requester, period, anchor, provider, projectId, retry]);

  useEffect(() => {
    if (!selectedDate || period === "all" || state !== "ready") {
      setDetail(null);
      setDetailDate(null);
      return;
    }
    let active = true;
    setDetail(null);
    setDetailDate(null);
    const params = makeQuery(period, anchor, provider, projectId);
    if (projectRosterKey) params.set("project_roster", projectRosterKey);
    void requester(`${API_URL}/days/${selectedDate}?${params.toString()}`, { credentials: "same-origin" })
      .then(async response => {
        if (response.status === 403) throw Object.assign(new Error("forbidden"), { status: 403 });
        if (!response.ok) throw new Error(`조회 실패: ${response.status}`);
        return response.json() as Promise<UsageStatsDayDetail>;
      })
      .then(data => {
        if (!active) return;
        setDetail(data);
        setDetailDate(selectedDate);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setOverview(null);
        setState(typeof error === "object" && error !== null && "status" in error && error.status === 403 ? "forbidden" : "error");
      });
    return () => { active = false; };
  }, [requester, selectedDate, period, anchor, provider, projectId, projectRosterKey, state]);

  const overviewLoading = state === "loading";
  const detailLoading = Boolean(selectedDate) && detailDate !== selectedDate && state === "ready";
  const displayedAggregate = selectedDate ? detailDate === selectedDate ? detail?.totals ?? null : null : overview?.totals ?? null;
  const displayedModels = selectedDate ? detailDate === selectedDate ? detail?.by_model ?? [] : [] : overview?.by_model ?? [];
  const displayedProjects = selectedDate ? detailDate === selectedDate ? detail?.by_project ?? [] : [] : overview?.by_project ?? [];
  const noRecords = state === "ready" && overview?.totals.metrics.total_tokens === 0 && !overview.totals.is_partial && !isAggregateActive(overview.totals);
  const beforeCoverage = state === "ready" && range.effective_until <= coveredSince;
  const selectedNoRecords = Boolean(selectedDate && detailDate === selectedDate && detail && !isAggregateActive(detail.totals));
  const providerRowsForSeries = overview?.by_model ?? [];
  const projectRowsForSeries = overview?.by_project ?? [];
  const providerChartSeries = providerSeries(providerRowsForSeries, provider, periodModelRoster);
  const projectChartSeries = projectSeries(projectRowsForSeries);
  const projectColors = new Map(projectChartSeries.map(item => [item.key, item.color] as const));
  const providerPoints = (overview?.series ?? []).filter(point => point.provider !== undefined && providerPointKey(point, provider) !== "__unknown__");
  const projectPoints = (overview?.series ?? []).filter(point => point.project_id !== undefined);
  const providerKnownTotal = metricTotal(displayedModels, metric);
  const projectKnownTotal = metricTotal(displayedProjects, metric);
  const dateLabel = selectedDate ? formatUsageStatsDateWithWeekday(selectedDate) : null;
  const coverageLabel = displayedAggregate ? formatUsageStatsCoverage(
    displayedAggregate.coverage.priced_total_tokens,
    displayedAggregate.metrics.total_tokens,
  ) : "";
  const periodLabel = formatUsageStatsPeriodLabel(period, range.since, range.until);

  const chooseBucket = (bucket: string, intent: "toggle" | "set") => {
    if (!bucket) { setSelectedDate(null); return; }
    if (period === "all") {
      setSelectedDate(null);
      setPeriod("month");
      setAnchor(usageStatsMonthAnchor(bucket, overview!.as_of));
      return;
    }
    if (intent === "set") {
      setSelectedDate(bucket);
      return;
    }
    setSelectedDate(current => current === bucket ? null : bucket);
  };
  const changePeriod = (next: string) => {
    setSelectedDate(null);
    setPeriod(next as UsageStatsPeriod);
  };
  const shiftPeriod = (direction: number) => {
    setSelectedDate(null);
    setAnchor(current => shiftUsageStatsAnchor(period, current, direction));
  };
  const changeProvider = (value: string) => {
    setSelectedDate(null);
    setProvider(value === "all" ? null : value as UsageStatsProvider);
  };
  const changeProject = (value: string) => {
    setSelectedDate(null);
    setProjectId(value === "all" ? null : value);
  };
  const previousAnchor = shiftUsageStatsAnchor(period, anchor, -1);
  const nextAnchor = shiftUsageStatsAnchor(period, anchor, 1);
  const previousDisabled = period === "all" || fallbackRange(period, previousAnchor).until <= coveredSince;
  const nextDisabled = period === "all" || fallbackRange(period, nextAnchor).since >= (overview?.as_of.slice(0, 10) ?? "2026-10-19");

  const summaryValue = (metricName: Metric) => {
    if (overviewLoading || detailLoading) return "불러오는 중…";
    if (beforeCoverage) return metricName === "tokens" ? "미기록" : "미확인";
    return displayedAggregate ? valueForMetric(displayedAggregate.metrics, metricName, displayedAggregate.is_partial, displayedAggregate.coverage) : "미기록";
  };
  const shownError = state === "forbidden" || state === "error";

  return <div className="usage-stats-tab">
    <div className="usage-stats-controls">
      <PeriodButtons value={period} onChange={changePeriod} label="통계 기간" />
      <div className="usage-stats-range-controls">
        {period !== "all" ? <DashboardIconCap size="small" label="이전 기간" disabled={previousDisabled} onClick={() => shiftPeriod(-1)}><ChevronLeft className="size-4" aria-hidden="true" /></DashboardIconCap> : null}
        <p className="usage-stats-period-label" aria-live="polite">{periodLabel}</p>
        {period !== "all" ? <DashboardIconCap size="small" label="다음 기간" disabled={nextDisabled} onClick={() => shiftPeriod(1)}><ChevronRight className="size-4" aria-hidden="true" /></DashboardIconCap> : null}
      </div>
      <div className="usage-stats-filters">
        <CatalogSelectionField
          label="모델"
          ariaLabel="모델"
          value={provider ?? "all"}
          selectedLabel={providerOptions.find(option => option.value === (provider ?? "all"))?.label ?? "모든 모델"}
          options={providerOptions}
          onValueChange={changeProvider}
        />
        <CatalogSelectionField
          label="프로젝트"
          ariaLabel="프로젝트"
          value={projectId ?? "all"}
          selectedLabel={selectedProjectLabel}
          options={projectOptions}
          onValueChange={changeProject}
        />
      </div>
    </div>

    {shownError ? <SettingsAlert>
      <div className="usage-stats-error-content">
        <span>{state === "forbidden" ? "이 통계를 볼 권한이 없습니다." : "통계를 불러오지 못했습니다."}</span>
        {state === "error" ? <Button size="sm" variant="ghost" onClick={() => setRetry(current => current + 1)}>다시 불러오기</Button> : null}
      </div>
    </SettingsAlert> : (
      <>
        <SettingsGroupBox>
          <div className="usage-stats-summary">
            {selectedDate ? <Button size="sm" variant="outline" className="usage-stats-date-chip" onClick={() => setSelectedDate(null)}>
              {dateLabel}<X className="size-3" aria-hidden="true" />
            </Button> : null}
            <div className="usage-stats-summary-values">
              <div className="usage-stats-summary-metric"><span>토큰</span><strong>{summaryValue("tokens")}</strong></div>
              <div className="usage-stats-summary-metric"><span>정가</span><strong>{summaryValue("cost")}</strong></div>
            </div>
            <div className="usage-stats-summary-meta" aria-live="polite">
              {overviewLoading || detailLoading ? null : displayedAggregate?.coverage.missing_usage_turns ? <span>미기록 턴 {displayedAggregate.coverage.missing_usage_turns}</span> : null}
              {overviewLoading || detailLoading ? null : coverageLabel ? <span>{coverageLabel}</span> : null}
              {overview?.projection_status.state === "backfilling" ? <span>이전 기록 정리 중</span> : null}
            </div>
            <details className="config-advanced usage-stats-disclosure">
              <summary>{USAGE_STATS_LABELS.tokenDetails}</summary>
            {overviewLoading || detailLoading ? <p className="usage-stats-muted">불러오는 중…</p> : displayedAggregate ? <dl className="usage-stats-token-details">
                <div><dt>{USAGE_STATS_LABELS.input}</dt><dd>{formatUsageStatsTokenCount(displayedAggregate.metrics.input_total, false)}</dd></div>
                <div><dt>{USAGE_STATS_LABELS.cacheRead}</dt><dd>{formatUsageStatsTokenCount(displayedAggregate.metrics.cache_read, false)}</dd></div>
                <div><dt>{USAGE_STATS_LABELS.cacheWrite}</dt><dd>{formatUsageStatsTokenCount(displayedAggregate.metrics.cache_write, false)}</dd></div>
                <div><dt>{USAGE_STATS_LABELS.output}</dt><dd>{formatUsageStatsTokenCount(displayedAggregate.metrics.output_total, false)}</dd></div>
                <div><dt>{USAGE_STATS_LABELS.reasoning}</dt><dd>{formatUsageStatsTokenCount(displayedAggregate.metrics.reasoning_output, false)}</dd></div>
              </dl> : <p className="usage-stats-muted">{overviewLoading || detailLoading ? "불러오는 중…" : "미기록"}</p>}
            </details>
            <details className="config-advanced usage-stats-disclosure">
              <summary>집계 기준</summary>
              <div className="usage-stats-basis">
                <p>2026-10-19 공개 API 정가 USD 환산(standard, 기본 컨텍스트). 구독 실지출 아님</p>
                <p>단가 출처: <a href="https://developers.openai.com/api/docs/pricing?tab=suite" target="_blank" rel="noreferrer">OpenAI</a>, <a href="https://platform.claude.com/docs/en/about-claude/pricing" target="_blank" rel="noreferrer">Claude</a>, <a href="https://ai.google.dev/gemini-api/docs/pricing" target="_blank" rel="noreferrer">Gemini</a>, <a href="https://api-docs.deepseek.com/quick_start/pricing/" target="_blank" rel="noreferrer">DeepSeek</a>, <a href="https://platform.kimi.ai/docs/pricing/chat" target="_blank" rel="noreferrer">Kimi</a></p>
                <p>날짜는 턴이 끝난 시각, Asia/Seoul, 주는 월요일 시작</p>
                <p>프로젝트는 지금 보이는 최상위 폴더 기준</p>
              </div>
            </details>
          </div>

          <div className="usage-stats-chart-heading">
            <h3>모델별</h3>
            <div className="v3-completed-periods" role="group" aria-label="표시 값">
              <Button size="sm" variant="ghost" aria-pressed={metric === "tokens"} onClick={() => setMetric("tokens")}>토큰</Button>
              <Button size="sm" variant="ghost" aria-pressed={metric === "cost"} onClick={() => setMetric("cost")}>정가</Button>
            </div>
          </div>
          <UsageStackedBars
            label="모델별 사용량"
            kind="provider"
            period={period}
            range={range}
            coveredSince={coveredSince}
            points={overviewLoading ? [] : providerPoints}
            series={providerChartSeries}
            metric={metric}
            selectedBucket={selectedDate}
            loading={overviewLoading}
            emptyMessage={beforeCoverage ? "이 기간은 기록 전입니다" : noRecords ? "이 기간에 기록이 없습니다" : null}
            providerSelected={provider !== null}
            onSelect={chooseBucket}
          />
          {(noRecords || beforeCoverage) && !overviewLoading ? null : <div className="usage-stats-share-list">
            {overviewLoading || detailLoading ? <p className="usage-stats-muted">불러오는 중…</p> : displayedModels.map(row => {
              const value = metricValue(row.metrics, metric);
              const name = row.model ? formatUsageStatsModelLabel(row.model) : formatUsageStatsProviderLabel(row.provider);
              const isProviderRow = row.attribution === "provider";
              return <UsageShareRow
                key={`${row.provider}:${row.model ?? "provider"}`}
                name={name}
                value={valueForMetric(row.metrics, metric, row.is_partial, row.coverage, true)}
                share={shareFor(value, providerKnownTotal)}
                color={providerChartSeries.find(item => item.key === (provider ? `${row.provider}:${row.model ?? "__unknown__"}` : row.provider))?.color}
                onClick={isProviderRow ? () => changeProvider(row.provider) : undefined}
              />;
            })}
          </div>}
        </SettingsGroupBox>

        {!noRecords && !beforeCoverage ? <SettingsGroupBox title="프로젝트별">
          <UsageStackedBars
            label="프로젝트별 사용량"
            kind="project"
            period={period}
            range={range}
            coveredSince={coveredSince}
            points={overviewLoading ? [] : projectPoints}
            series={projectChartSeries}
            metric={metric}
            selectedBucket={selectedDate}
            loading={overviewLoading}
            emptyMessage={beforeCoverage ? "이 기간은 기록 전입니다" : noRecords ? "이 기간에 기록이 없습니다" : null}
            onSelect={chooseBucket}
          />
          <div className="usage-stats-share-list">
            {overviewLoading || detailLoading ? <p className="usage-stats-muted">불러오는 중…</p> : displayedProjects.map(row => {
              const value = metricValue(row.metrics, metric);
              const selectable = row.project_id !== "__other__";
              return <UsageShareRow
                key={row.project_id ?? "unclassified"}
                name={row.label}
                value={valueForMetric(row.metrics, metric, row.is_partial, row.coverage, true)}
                share={shareFor(value, projectKnownTotal)}
                color={row.project_id === null || row.project_id === "__other__"
                  ? "var(--v3-text-tertiary)"
                  : projectColors.get(row.project_id) ?? "var(--v3-text-tertiary)"}
                onClick={selectable ? () => changeProject(row.project_id ?? "__unclassified__") : undefined}
              />;
            })}
          </div>
        </SettingsGroupBox> : null}

        {period !== "all" && !noRecords && !beforeCoverage && !selectedNoRecords ? <SettingsGroupBox title="입력 자료 구성">
          {!selectedDate ? <p className="usage-stats-muted">막대에서 날짜를 고르세요</p> : detailLoading ? <p className="usage-stats-muted" role="status">불러오는 중…</p> : detail ? <InputMaterial detail={detail} /> : null}
        </SettingsGroupBox> : null}
      </>
    )}
  </div>;
}

function InputMaterial({ detail }: { detail: UsageStatsDayDetail }) {
  const material = detail.input_material;
  const parts = material.parts.filter(part => part.category !== "harness_internal");
  const denominator = material.observed_chars;
  return <div className="usage-stats-input-material">
    <p className="usage-stats-input-total">{formatUsageStatsChars(denominator, true)}</p>
    <div className="usage-stats-share-list">
      {parts.map((part, index) => <UsageShareRow
        key={`${part.category}:${part.source_key ?? index}`}
        name={formatUsageStatsInputCategoryLabel(part.category)}
        value={formatUsageStatsChars(part.chars)}
        share={part.share}
        color="var(--v3-accent)"
      />)}
      <UsageShareRow name="하네스 내부 입력" value="관측 안 됨" share={null} />
    </div>
    <p className="usage-stats-input-meta">툴 호출 {detail.tool_calls.toLocaleString("ko-KR")}회</p>
    {material.coverage.partial_samples > 0 || material.coverage.missing_samples > 0 ? <p className="usage-stats-input-meta">{USAGE_STATS_LABELS.missingInput}</p> : null}
  </div>;
}
