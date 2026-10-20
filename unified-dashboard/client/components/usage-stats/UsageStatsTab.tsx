import { useMemo, useState } from "react";
import {
  Button,
  DashboardIconCap,
  buildUsageStatsModelOptions,
  formatUsageStatsCacheSplit,
  formatUsageStatsCoverage,
  formatUsageStatsDateWithWeekday,
  formatUsageStatsModelLabel,
  formatUsageStatsPeriodLabel,
  formatUsageStatsProviderLabel,
  formatUsageStatsTokenCount,
  formatUsageStatsUsd,
  formatUsageStatsValue,
  formatUsageStatsApproximateTokens,
  groupUsageStatsInputMaterial,
  USAGE_STATS_LABELS,
  usageStatsCalendarRange,
  usageStatsFilterKey,
  usageStatsKstDate,
  usageStatsMetricValue,
  usageStatsMonthAnchor,
  usageStatsModelColorIndex,
  usageStatsSeriesKey,
  shiftUsageStatsAnchor,
} from "@seosoyoung/soul-ui";
import type {
  UsageStatsAggregate,
  UsageStatsDayDetail,
  UsageStatsOptions,
  UsageStatsOverview,
  UsageStatsPeriod,
  UsageStatsProjectRow,
  UsageStatsProvider,
  UsageStatsProviderRow,
} from "@seosoyoung/soul-ui";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { CatalogSelectionField } from "../CatalogSelectionField";
import { SettingsAlert, SettingsGroupBox } from "../config/SettingsListDetail";
import { UsageShareRow } from "./UsageShareRow";
import { UsageStackedBars, type UsageChartSeries } from "./UsageStackedBars";
import { ALL_USAGE_STATS_FILTER, useUsageStats, type UsageStatsFilter } from "./useUsageStats";
import "./usage-stats.css";

type Metric = "tokens" | "cost";
type SelectedProject = { value: string; label: string };

function isAggregateActive(aggregate: UsageStatsAggregate | null): boolean {
  if (!aggregate) return false;
  const { metrics, coverage } = aggregate;
  return (metrics.total_tokens ?? 0) > 0 || coverage.usage_complete_events > 0 || coverage.usage_partial_events > 0 ||
    coverage.missing_usage_turns > 0 || coverage.pending_inputs > 0 || coverage.unpriced_events > 0 || coverage.unknown_total_token_events > 0;
}

function valueForMetric(
  metrics: UsageStatsAggregate["metrics"],
  metric: Metric,
  coverage: UsageStatsAggregate["coverage"],
  row = false,
  includeCacheRead?: boolean,
): string {
  return includeCacheRead === undefined
    ? formatUsageStatsValue(metrics, coverage, metric, row)
    : formatUsageStatsValue(metrics, coverage, metric, row, includeCacheRead);
}

function shareFor(value: number | null, total: number): number | null {
  return value === null ? null : total > 0 ? value / total : value === 0 ? 0 : null;
}

function providerColor(provider: UsageStatsProvider): string {
  if (provider === "unknown") return "var(--v3-text-tertiary)";
  return `var(--usage-stats-provider-${provider})`;
}

function projectColor(index: number): string {
  return index >= 0 && index < 5 ? `var(--usage-stats-project-${index + 1})` : "var(--v3-text-tertiary)";
}

function providerSeries(rows: readonly UsageStatsProviderRow[], modelMode: boolean, options: UsageStatsOptions | undefined): UsageChartSeries[] {
  return rows.map(row => ({
    key: usageStatsSeriesKey(row.provider, row.model, modelMode),
    label: row.attribution === "provider"
      ? formatUsageStatsProviderLabel(row.provider)
      : row.model === null ? "모델 미상" : formatUsageStatsModelLabel(row.model),
    color: row.provider === "unknown" || (modelMode && row.model === null)
      ? "var(--v3-text-tertiary)"
      : modelMode ? projectColor(usageStatsModelColorIndex(
        row.model,
        options?.model_rosters.find(roster => roster.provider === row.provider)?.models ?? [],
      ))
      : providerColor(row.provider),
  }));
}

function projectSeries(rows: readonly UsageStatsProjectRow[], options: UsageStatsOptions | undefined): UsageChartSeries[] {
  return rows.map((row, index) => ({
    key: row.project_id ?? "__unclassified__",
    label: row.label,
    color: row.project_id === null || row.project_id === "__other__"
      ? "var(--v3-text-tertiary)"
      : projectColor(options?.projects.findIndex(project => project.project_id === row.project_id) ?? index),
  }));
}

function metricTotal(
  rows: readonly { metrics: UsageStatsAggregate["metrics"] }[],
  metric: Metric,
  includeCacheRead: boolean,
): number {
  let total = 0;
  for (const row of rows) {
    const value = usageStatsMetricValue(row.metrics, metric, includeCacheRead);
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
  const [today] = useState(() => usageStatsKstDate(Date.now()));
  const [period, setPeriod] = useState<UsageStatsPeriod>("week");
  const [anchor, setAnchor] = useState(today);
  const [filter, setFilter] = useState<UsageStatsFilter>(ALL_USAGE_STATS_FILTER);
  const [selectedProject, setSelectedProject] = useState<SelectedProject | null>(null);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [metric, setMetric] = useState<Metric>("tokens");
  const [includeCacheRead, setIncludeCacheRead] = useState(false);
  const [view, setView] = useState<"model" | "project">("model");
  const projectId = selectedProject?.value ?? null;
  const requester = request ?? fetch;
  const { overview, detail, state, overviewLoading, detailLoading, retry } = useUsageStats({
    request: requester,
    period,
    anchor,
    filter,
    projectId,
    selectedDate,
  });
  const range = overview?.range ?? null;
  const coveredSince = overview?.projection_status.covered_since ?? null;
  const overviewReady = state === "ready" && overview !== null;
  const forbidden = state === "forbidden";
  const modelOptions = useMemo(() => {
    const allKey = usageStatsFilterKey("all", null, null);
    if (forbidden) return [ALL_USAGE_STATS_FILTER];
    const built: UsageStatsFilter[] = [ALL_USAGE_STATS_FILTER];
    if (overview) {
      for (const option of buildUsageStatsModelOptions(overview.options)) {
        if (option.id === allKey) continue;
        if (option.provider !== null && option.model === null) {
          built.push({ ...option, kind: "provider", provider: option.provider, model: null });
        } else if (option.provider !== null && option.model !== null) {
          built.push({ ...option, kind: "model", provider: option.provider, model: option.model });
        }
      }
    }
    if (!built.some(option => option.id === filter.id)) built.push(filter);
    return built;
  }, [overview, filter, forbidden]);
  const projectOptions = useMemo(() => {
    const allProjects = { value: "all", label: "모든 프로젝트" };
    if (forbidden) return [allProjects];
    const built = [
      allProjects,
      ...(overview?.options.projects ?? []).map(project => ({ value: project.project_id, label: project.label })),
      { value: "__unclassified__", label: "미분류" },
    ];
    if (selectedProject && selectedProject.value !== "__unclassified__" &&
      !built.some(option => option.value === selectedProject.value)) built.push(selectedProject);
    return built;
  }, [overview?.options.projects, selectedProject, forbidden]);
  const selectedFilterLabel = forbidden
    ? ALL_USAGE_STATS_FILTER.label
    : modelOptions.find(option => option.id === filter.id)?.label ?? filter.label;
  const selectedProjectLabel = forbidden
    ? "모든 프로젝트"
    : projectOptions.find(option => option.value === (projectId ?? "all"))?.label ?? selectedProject?.label ?? "모든 프로젝트";
  const displayedAggregate = selectedDate ? detail?.totals ?? null : overviewReady ? overview?.totals ?? null : null;
  const displayedModels = selectedDate ? detail?.by_model ?? [] : overviewReady ? overview?.by_model ?? [] : [];
  const displayedProjects = selectedDate ? detail?.by_project ?? [] : overviewReady ? overview?.by_project ?? [] : [];
  const hasKnownPositive = Boolean(overview && (
    (overview.totals.metrics.total_tokens ?? 0) > 0 || (overview.totals.metrics.reference_cost_usd ?? 0) > 0
  ));
  const noRecords = Boolean(overviewReady && overview?.totals.metrics.total_tokens === 0 && !overview.totals.is_partial && !isAggregateActive(overview.totals));
  const unknownEmptyRange = Boolean(overview && overview.series.length === 0 && overview.totals.metrics.total_tokens === null);
  const beforeCoverage = Boolean(overviewReady && range && coveredSince && range.effective_until <= coveredSince && !hasKnownPositive);
  const selectedNoRecords = Boolean(selectedDate && detail && !isAggregateActive(detail.totals));
  const providerRowsForSeries = overviewReady ? overview?.by_model ?? [] : [];
  const projectRowsForSeries = overviewReady ? overview?.by_project ?? [] : [];
  const modelMode = filter.kind !== "all";
  const providerChartSeries = providerSeries(providerRowsForSeries, modelMode, overview?.options);
  const projectChartSeries = projectSeries(projectRowsForSeries, overview?.options);
  const projectColors = new Map(projectChartSeries.map(item => [item.key, item.color] as const));
  const chartPoints = useMemo(() => (overview?.series ?? []).map(point => ({
    ...point,
    metrics: {
      ...point.metrics,
      total_tokens: usageStatsMetricValue(point.metrics, "tokens", includeCacheRead),
      reference_cost_usd: usageStatsMetricValue(point.metrics, "cost", includeCacheRead),
    },
  })), [overview?.series, includeCacheRead]);
  const providerPoints = overviewReady ? chartPoints.filter(point => point.provider !== undefined) : [];
  const projectPoints = overviewReady ? chartPoints.filter(point => point.project_id !== undefined) : [];
  const providerKnownTotal = metricTotal(displayedModels, metric, includeCacheRead);
  const projectKnownTotal = metricTotal(displayedProjects, metric, includeCacheRead);
  const dateLabel = selectedDate ? formatUsageStatsDateWithWeekday(selectedDate) : null;
  const cacheSplit = formatUsageStatsCacheSplit(
    overviewLoading || detailLoading ? null : displayedAggregate?.metrics,
    overviewLoading || detailLoading ? null : displayedAggregate?.coverage,
  );
  const coverageLabel = displayedAggregate ? formatUsageStatsCoverage(
    displayedAggregate.coverage.priced_total_tokens,
    displayedAggregate.metrics.provider_total_tokens,
    displayedAggregate.coverage.token_partials.provider_total_tokens,
  ) : "";
  const calendarRange = period === "all" ? null : usageStatsCalendarRange(period, anchor);
  const periodLabel = range
    ? formatUsageStatsPeriodLabel(period, range.since, range.until)
    : period === "all" ? "전체" : formatUsageStatsPeriodLabel(period, calendarRange!.since, calendarRange!.until);

  const chooseBucket = (bucket: string, intent: "toggle" | "set") => {
    if (!bucket) { setSelectedDate(null); return; }
    if (period === "all") {
      if (!overview) return;
      setSelectedDate(null);
      setPeriod("month");
      setAnchor(usageStatsMonthAnchor(bucket, overview.as_of));
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
  const changeFilter = (value: string) => {
    if (forbidden) return;
    const next = modelOptions.find(option => option.id === value);
    if (!next) return;
    setSelectedDate(null);
    setFilter(next);
  };
  const changeProject = (value: string) => {
    if (forbidden) return;
    const next = projectOptions.find(option => option.value === value);
    if (!next) return;
    setSelectedDate(null);
    setSelectedProject(value === "all" ? null : next);
  };
  const previousAnchor = shiftUsageStatsAnchor(period, anchor, -1);
  const nextAnchor = shiftUsageStatsAnchor(period, anchor, 1);
  const previousRange = period === "all" ? null : usageStatsCalendarRange(period, previousAnchor);
  const nextRange = period === "all" ? null : usageStatsCalendarRange(period, nextAnchor);
  const asOfDate = overview ? usageStatsKstDate(overview.as_of) : today;
  const previousDisabled = period === "all" || Boolean(previousRange && coveredSince && previousRange.until <= coveredSince);
  const nextDisabled = period === "all" || Boolean(nextRange && nextRange.since > asOfDate);

  const summaryValue = (metricName: Metric) => {
    if (overviewLoading || detailLoading) return "불러오는 중…";
    if (beforeCoverage) return metricName === "tokens" ? "미기록" : "미확인";
    return displayedAggregate ? valueForMetric(displayedAggregate.metrics, metricName, displayedAggregate.coverage) : "미기록";
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
          key={forbidden ? "model:forbidden" : "model:active"}
          label="모델"
          ariaLabel="모델"
          value={forbidden ? ALL_USAGE_STATS_FILTER.id : filter.id}
          selectedLabel={selectedFilterLabel}
          options={modelOptions.map(option => ({ value: option.id, label: option.label }))}
          disabled={forbidden}
          onValueChange={changeFilter}
        />
        <CatalogSelectionField
          key={forbidden ? "project:forbidden" : "project:active"}
          label="프로젝트"
          ariaLabel="프로젝트"
          value={forbidden ? "all" : projectId ?? "all"}
          selectedLabel={selectedProjectLabel}
          options={projectOptions}
          disabled={forbidden}
          onValueChange={changeProject}
        />
      </div>
    </div>

    {shownError ? <SettingsAlert>
      <div className="usage-stats-error-content">
        <span>{state === "forbidden" ? "이 통계를 볼 권한이 없습니다." : "통계를 불러오지 못했습니다."}</span>
        {state === "error" ? <Button size="sm" variant="ghost" onClick={retry}>다시 불러오기</Button> : null}
      </div>
    </SettingsAlert> : (
      <>
        <SettingsGroupBox>
          <div className="usage-stats-summary">
            {selectedDate ? <Button size="sm" variant="outline" className="usage-stats-date-chip" onClick={() => setSelectedDate(null)}>
              {dateLabel}<X className="size-3" aria-hidden="true" />
            </Button> : null}
            <div className="usage-stats-summary-values">
              <div className="usage-stats-summary-metric"><span>토큰</span><strong>{summaryValue("tokens")}</strong><span>{cacheSplit.cacheReadLine}</span></div>
              <div className="usage-stats-summary-metric"><span>정가</span><strong>{summaryValue("cost")}</strong></div>
            </div>
            <div className="usage-stats-share-list">
              <UsageShareRow name={USAGE_STATS_LABELS.nonCacheCost} value={cacheSplit.nonCacheCost} share={null} />
              <UsageShareRow name={USAGE_STATS_LABELS.cacheReadCost} value={cacheSplit.cacheReadCost} share={null} />
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
                <div><dt>{USAGE_STATS_LABELS.uncachedInput}</dt><dd>{cacheSplit.ordinaryInput}</dd></div>
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
                <p>{USAGE_STATS_LABELS.inputEstimateBasis}</p>
                <p>{USAGE_STATS_LABELS.inputEstimateCaveat}</p>
              </div>
            </details>
          </div>

          <div className="usage-stats-chart-heading">
            <CatalogSelectionField
              label="보기"
              ariaLabel="그래프 보기"
              value={view}
              options={[{ value: "model", label: "모델별" }, { value: "project", label: "프로젝트별" }]}
              selectedLabel={view === "model" ? "모델별" : "프로젝트별"}
              onValueChange={value => setView(value as "model" | "project")}
            />
            <div className="v3-completed-periods">
              <div className="v3-completed-periods" role="group" aria-label="표시 값">
                <Button size="sm" variant="ghost" aria-pressed={metric === "tokens"} onClick={() => setMetric("tokens")}>토큰</Button>
                <Button size="sm" variant="ghost" aria-pressed={metric === "cost"} onClick={() => setMetric("cost")}>정가</Button>
              </div>
              <div className="v3-completed-periods" role="group" aria-label={USAGE_STATS_LABELS.cacheReadToggleGroup}>
                <Button size="sm" variant="ghost" aria-pressed={!includeCacheRead} onClick={() => setIncludeCacheRead(false)}>{USAGE_STATS_LABELS.cacheReadExclude}</Button>
                <Button size="sm" variant="ghost" aria-pressed={includeCacheRead} onClick={() => setIncludeCacheRead(true)}>{USAGE_STATS_LABELS.cacheReadInclude}</Button>
              </div>
            </div>
          </div>
          <UsageStackedBars
            label={view === "model" ? "모델별 사용량" : "프로젝트별 사용량"}
            kind={view === "model" ? "provider" : "project"}
            period={period}
            range={range}
            coveredSince={coveredSince}
            points={overviewLoading ? [] : view === "model" ? providerPoints : projectPoints}
            series={view === "model" ? providerChartSeries : projectChartSeries}
            metric={metric}
            selectedBucket={selectedDate}
            loading={overviewLoading}
            emptyMessage={beforeCoverage ? "이 기간은 기록 전입니다" : noRecords ? "이 기간에 기록이 없습니다" : null}
            modelMode={view === "model" && modelMode}
            onSelect={chooseBucket}
          />
          {(noRecords || beforeCoverage) && !overviewLoading ? null : <div className="usage-stats-share-list">
            {overviewLoading || detailLoading ? <p className="usage-stats-muted">불러오는 중…</p> : view === "model" ? displayedModels.map(row => {
              const value = usageStatsMetricValue(row.metrics, metric, includeCacheRead);
              const name = row.attribution === "provider"
                ? formatUsageStatsProviderLabel(row.provider)
                : row.model === null ? "모델 미상" : formatUsageStatsModelLabel(row.model);
              const isProviderRow = row.attribution === "provider";
              const seriesKey = usageStatsSeriesKey(row.provider, row.model, modelMode);
              return <UsageShareRow
                key={seriesKey}
                name={name}
                value={valueForMetric(row.metrics, metric, row.coverage, true, includeCacheRead)}
                share={shareFor(value, providerKnownTotal)}
                color={providerChartSeries.find(item => item.key === seriesKey)?.color}
                onClick={isProviderRow ? () => changeFilter(usageStatsFilterKey("provider", row.provider, null)) : undefined}
              />;
            }) : displayedProjects.map(row => {
              const value = usageStatsMetricValue(row.metrics, metric, includeCacheRead);
              const selectable = row.project_id !== "__other__";
              return <UsageShareRow
                key={row.project_id ?? "unclassified"}
                name={row.label}
                value={valueForMetric(row.metrics, metric, row.coverage, true, includeCacheRead)}
                share={shareFor(value, projectKnownTotal)}
                color={row.project_id === null || row.project_id === "__other__"
                  ? "var(--v3-text-tertiary)"
                  : projectColors.get(row.project_id) ?? "var(--v3-text-tertiary)"}
                onClick={selectable ? () => changeProject(row.project_id ?? "__unclassified__") : undefined}
              />;
            })}
          </div>}
        </SettingsGroupBox>

        {period !== "all" && !noRecords && !beforeCoverage && !selectedNoRecords && !unknownEmptyRange ? <SettingsGroupBox title="입력 자료 구성">
          {!selectedDate ? <p className="usage-stats-muted">막대에서 날짜를 고르세요</p> : detailLoading ? <p className="usage-stats-muted" role="status">불러오는 중…</p> : detail ? <InputMaterial detail={detail} /> : null}
        </SettingsGroupBox> : null}
      </>
    )}
  </div>;
}

function InputMaterial({ detail }: { detail: UsageStatsDayDetail }) {
  const material = detail.input_material;
  const rows = groupUsageStatsInputMaterial(material);
  return <div className="usage-stats-input-material">
    <p className="usage-stats-input-total">{formatUsageStatsApproximateTokens(material.observed_approximate_tokens, true)}</p>
    <div className="usage-stats-share-list">
      {rows.map(row => <UsageShareRow
        key={row.category}
        name={row.label}
        value={formatUsageStatsApproximateTokens(row.approximate_tokens, row.category === "harness_internal", row.partial)}
        share={row.share}
        color={row.category === "harness_internal" ? undefined : "var(--v3-accent)"}
      />)}
    </div>
    <p className="usage-stats-input-meta">툴 호출 {detail.tool_calls.toLocaleString("ko-KR")}회</p>
    {material.coverage.partial_samples > 0 || material.coverage.missing_samples > 0 ? <p className="usage-stats-input-meta">{USAGE_STATS_LABELS.missingInput}</p> : null}
  </div>;
}
