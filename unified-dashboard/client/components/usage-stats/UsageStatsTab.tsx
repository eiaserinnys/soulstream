import { intlLocale, resolveLanguage } from "@soulstream/i18n";
import { useTranslation } from "react-i18next";
import type { AdminTranslate } from "../config/admin-translation";
import { useMemo, useState } from "react";
import {
  Button,
  DashboardIconCap,
  FrameLoading,
  buildUsageStatsModelOptions,
  formatUsageStatsModelLabel,
  formatUsageStatsProviderLabel,
  groupUsageStatsInputMaterial,
  usageStatsCalendarRange,
  usageStatsFilterKey,
  usageStatsKstDate,
  usageStatsMetricValue,
  usageStatsMonthAnchor,
  usageStatsModelColorIndex,
  usageStatsSeriesKey,
  shiftUsageStatsAnchor,
} from "@seosoyoung/soul-ui";
import type { UsageStatsAggregate, UsageStatsDayDetail, UsageStatsOptions, UsageStatsPeriod, UsageStatsProjectRow, UsageStatsProvider, UsageStatsProviderRow } from "../../../../packages/wire-schema/src/session_statistics";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { CatalogSelectionField } from "../CatalogSelectionField";
import { SettingsAlert, SettingsGroupBox } from "../config/SettingsListDetail";
import { UsageShareRow } from "./UsageShareRow";
import { UsageStackedBars, type UsageChartSeries } from "./UsageStackedBars";
import { ALL_USAGE_STATS_FILTER, useUsageStats, type UsageStatsFilter } from "./useUsageStats";
import { approximateTokens, usageCacheSplit, usageCoverage, usageDate, usagePeriod, usageValue } from "./usage-format";
import "./usage-stats.css";

type Metric = "tokens" | "cost";
type SelectedProject = { value: string; label: string };

function isAggregateActive(aggregate: UsageStatsAggregate | null): boolean {
  if (!aggregate) return false;
  const { metrics, coverage } = aggregate;
  return (metrics.total_tokens ?? 0) > 0 || coverage.usage_complete_events > 0 || coverage.usage_partial_events > 0 ||
    coverage.missing_usage_turns > 0 || coverage.pending_inputs > 0 || coverage.unpriced_events > 0 || coverage.unknown_total_token_events > 0;
}

function shareFor(value: number | null, total: number): number | null {
  return value === null ? null : total > 0 ? value / total : value === 0 ? 0 : null;
}

function providerColor(provider: UsageStatsProvider): string {
  if (provider === "unknown") return "var(--v3-text-tertiary)";
  return `var(--usage-stats-provider-${provider})`;
}

function projectColor(index: number): string {
  return index >= 0 ? `var(--usage-stats-project-${(index % 5) + 1})` : "var(--v3-text-tertiary)";
}

function providerSeries(rows: readonly UsageStatsProviderRow[], modelMode: boolean, options: UsageStatsOptions | undefined, t: AdminTranslate): UsageChartSeries[] {
  return rows.map(row => ({
    key: usageStatsSeriesKey(row.provider, row.model, modelMode),
    label: row.attribution === "provider"
      ? (row.provider === "unknown" ? t("admin.stats.unknownProvider") : formatUsageStatsProviderLabel(row.provider))
      : (row.model || row.model_label ? formatUsageStatsModelLabel(row.model, row.model_label) : t("admin.stats.unknownModel")),
    color: row.provider === "unknown" || (modelMode && row.model === null)
      ? "var(--v3-text-tertiary)"
      : modelMode ? projectColor(usageStatsModelColorIndex(
        row.model,
        options?.model_rosters.find(roster => roster.provider === row.provider)?.models ?? [],
      ))
      : providerColor(row.provider),
  }));
}

function projectSeries(rows: readonly UsageStatsProjectRow[], options: UsageStatsOptions | undefined, t: AdminTranslate): UsageChartSeries[] {
  return rows.map((row, index) => ({
    key: row.project_id ?? "__unclassified__",
    label: projectLabel(row, t),
    color: row.project_id === null || row.project_id === "__other__"
      ? "var(--v3-text-tertiary)"
      : projectColor(options?.projects.findIndex(project => project.project_id === row.project_id) ?? index),
  }));
}

function projectLabel(row: UsageStatsProjectRow, t: AdminTranslate): string {
  if (row.project_id === null) return t("admin.stats.unclassified");
  if (row.project_id === "__other__") return t("admin.stats.otherFolders");
  return row.label;
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
  const { t } = useTranslation();
  const options = [{ value: "week", label: t("admin.stats.week") }, { value: "month", label: t("admin.stats.month") }, { value: "all", label: t("admin.stats.all") }];
  return <div className="v3-completed-periods" role="group" aria-label={label}>
    {options.map(option => <Button key={option.value} size="sm" variant="ghost" aria-pressed={value === option.value} onClick={() => onChange(option.value)}>{option.label}</Button>)}
  </div>;
}

export function UsageStatsTab({ request = fetch }: { request?: typeof fetch } = {}) {
  const { t, i18n } = useTranslation();
  const locale = intlLocale(resolveLanguage(i18n.resolvedLanguage, []));
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
    const allModels = { ...ALL_USAGE_STATS_FILTER, label: t("admin.stats.allModels") };
    if (forbidden) return [allModels];
    const built: UsageStatsFilter[] = [allModels];
    if (overview) {
      for (const option of buildUsageStatsModelOptions(overview.options)) {
        if (option.id === allKey) continue;
        if (option.provider !== null && option.model === null) {
          built.push({ ...option, kind: "provider", provider: option.provider, model: null, label: option.provider === "unknown" ? t("admin.stats.unknownProvider") : option.label });
        } else if (option.provider !== null && option.model !== null) {
          built.push({ ...option, kind: "model", provider: option.provider, model: option.model });
        }
      }
    }
    if (!built.some(option => option.id === filter.id)) built.push(filter);
    return built;
  }, [overview, filter, forbidden, t]);
  const projectOptions = useMemo(() => {
    const allProjects = { value: "all", label: t("admin.stats.allFolders") };
    if (forbidden) return [allProjects];
    const built = [
      allProjects,
      ...(overview?.options.projects ?? []).map(project => ({ value: project.project_id, label: project.label })),
      { value: "__unclassified__", label: t("admin.stats.unclassified") },
    ];
    if (selectedProject && selectedProject.value !== "__unclassified__" &&
      !built.some(option => option.value === selectedProject.value)) built.push(selectedProject);
    return built;
  }, [overview?.options.projects, selectedProject, forbidden, t]);
  const selectedFilterLabel = forbidden
    ? t("admin.stats.allModels")
    : modelOptions.find(option => option.id === filter.id)?.label ?? filter.label;
  const selectedProjectLabel = forbidden
    ? t("admin.stats.allFolders")
    : projectOptions.find(option => option.value === (projectId ?? "all"))?.label ?? selectedProject?.label ?? t("admin.stats.allFolders");
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
  const providerChartSeries = providerSeries(providerRowsForSeries, modelMode, overview?.options, t);
  const projectChartSeries = projectSeries(projectRowsForSeries, overview?.options, t);
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
  const dateLabel = selectedDate ? usageDate(selectedDate, locale, { month: "short", day: "numeric", weekday: "short" }) : null;
  const cacheSplit = usageCacheSplit(
    overviewLoading || detailLoading ? null : displayedAggregate?.metrics,
    overviewLoading || detailLoading ? null : displayedAggregate?.coverage,
    t, locale,
  );
  const coverageLabel = displayedAggregate ? usageCoverage(
    displayedAggregate.coverage.priced_total_tokens,
    displayedAggregate.metrics.provider_total_tokens,
    displayedAggregate.coverage.token_partials.provider_total_tokens,
    t, locale,
  ) : "";
  const calendarRange = period === "all" ? null : usageStatsCalendarRange(period, anchor);
  const periodLabel = range
    ? usagePeriod(period, range.since, range.until, locale)
    : period === "all" ? t("admin.stats.all") : usagePeriod(period, calendarRange!.since, calendarRange!.until, locale);

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
    // 값이 들어갈 자리에는 로딩 글자를 넣지 않는다. 첫 로딩의 진행 표시는 막대 프레임 하나다.
    if (overviewLoading || detailLoading) return "";
    if (beforeCoverage) return metricName === "tokens" ? t("admin.stats.missingUsage") : t("admin.stats.unknownCost");
    return displayedAggregate
      ? usageValue(displayedAggregate.metrics, displayedAggregate.coverage, metricName, false, metricName === "cost", t, locale)
      : t("admin.stats.missingUsage");
  };
  const shownError = state === "forbidden" || state === "error";

  return <div className="usage-stats-tab">
    <div className="usage-stats-controls">
      <PeriodButtons value={period} onChange={changePeriod} label={t("admin.stats.period")} />
      <div className="usage-stats-range-controls">
        {period !== "all" ? <DashboardIconCap size="small" label={t("admin.stats.previous")} disabled={previousDisabled} onClick={() => shiftPeriod(-1)}><ChevronLeft className="size-4" aria-hidden="true" /></DashboardIconCap> : null}
        <p className="usage-stats-period-label" aria-live="polite" data-v3-selectable-content="true">{periodLabel}</p>
        {period !== "all" ? <DashboardIconCap size="small" label={t("admin.stats.next")} disabled={nextDisabled} onClick={() => shiftPeriod(1)}><ChevronRight className="size-4" aria-hidden="true" /></DashboardIconCap> : null}
      </div>
      <div className="usage-stats-filters">
        <CatalogSelectionField
          key={forbidden ? "model:forbidden" : "model:active"}
          label={t("admin.stats.model")}
          ariaLabel={t("admin.stats.model")}
          value={forbidden ? ALL_USAGE_STATS_FILTER.id : filter.id}
          selectedLabel={selectedFilterLabel}
          options={modelOptions.map(option => ({ value: option.id, label: option.label }))}
          disabled={forbidden}
          onValueChange={changeFilter}
        />
        <CatalogSelectionField
          key={forbidden ? "project:forbidden" : "project:active"}
          label={t("admin.stats.folder")}
          ariaLabel={t("admin.stats.folder")}
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
        <span data-v3-selectable-content="true">{state === "forbidden" ? t("admin.stats.forbidden") : t("admin.stats.loadError")}</span>
        {state === "error" ? <Button size="sm" variant="ghost" onClick={retry}>{t("admin.stats.retry")}</Button> : null}
      </div>
    </SettingsAlert> : (
      <>
        <SettingsGroupBox>
          <div className="usage-stats-summary">
            {selectedDate ? <Button size="sm" variant="outline" className="usage-stats-date-chip" onClick={() => setSelectedDate(null)}>
              {dateLabel}<X className="size-3" aria-hidden="true" />
            </Button> : null}
            <div className="usage-stats-summary-values">
              <div className="usage-stats-summary-metric"><span>{t("admin.stats.tokens")}</span><strong data-v3-selectable-content="true">{summaryValue("tokens")}</strong><span data-v3-selectable-content="true">{cacheSplit.cacheReadLine}</span></div>
              <div className="usage-stats-summary-metric"><span>{t("admin.stats.listPrice")}</span><strong data-v3-selectable-content="true">{summaryValue("cost")}</strong><span data-v3-selectable-content="true">{cacheSplit.cacheReadCostLine}</span></div>
            </div>
            <div className="usage-stats-summary-meta" aria-live="polite" data-loading={overviewLoading || detailLoading || undefined}>
              {overviewLoading || detailLoading ? null : displayedAggregate?.coverage.missing_usage_turns ? <span data-v3-selectable-content="true">{t("admin.stats.missingTurns", { count: displayedAggregate.coverage.missing_usage_turns.toLocaleString(locale) })}</span> : null}
              {overviewLoading || detailLoading ? null : coverageLabel ? <span data-v3-selectable-content="true">{coverageLabel}</span> : null}
              {overview?.projection_status.state === "backfilling" ? <span>{t("admin.stats.backfill")}</span> : null}
            </div>
          </div>

          <div className="usage-stats-chart-heading">
            <CatalogSelectionField
              label={t("admin.stats.view")}
              ariaLabel={t("admin.stats.chartView")}
              value={view}
              options={[{ value: "model", label: t("admin.stats.byModel") }, { value: "project", label: t("admin.stats.byFolder") }]}
              selectedLabel={view === "model" ? t("admin.stats.byModel") : t("admin.stats.byFolder")}
              onValueChange={value => setView(value as "model" | "project")}
            />
            <div className="usage-stats-chart-heading-controls">
              <div className="v3-completed-periods" role="group" aria-label={t("admin.stats.metric")}>
                <Button size="sm" variant="ghost" aria-pressed={metric === "tokens"} onClick={() => setMetric("tokens")}>{t("admin.stats.tokens")}</Button>
                <Button size="sm" variant="ghost" aria-pressed={metric === "cost"} onClick={() => setMetric("cost")}>{t("admin.stats.chartPrice")}</Button>
              </div>
              <div className="v3-completed-periods" role="group" aria-label={t("admin.stats.cacheRead")}>
                <Button size="sm" variant="ghost" aria-label={t("admin.stats.cacheReadExclude")} aria-pressed={!includeCacheRead} onClick={() => setIncludeCacheRead(false)}>{t("admin.stats.cacheOff")}</Button>
                <Button size="sm" variant="ghost" aria-label={t("admin.stats.cacheReadInclude")} aria-pressed={includeCacheRead} onClick={() => setIncludeCacheRead(true)}>{t("admin.stats.cacheOn")}</Button>
              </div>
            </div>
          </div>
          <UsageStackedBars
            label={view === "model" ? t("admin.stats.usageByModel") : t("admin.stats.usageByFolder")}
            kind={view === "model" ? "provider" : "project"}
            period={period}
            range={range}
            coveredSince={coveredSince}
            points={overviewLoading ? [] : view === "model" ? providerPoints : projectPoints}
            series={view === "model" ? providerChartSeries : projectChartSeries}
            metric={metric}
            selectedBucket={selectedDate}
            loading={overviewLoading}
            emptyMessage={beforeCoverage ? t("admin.stats.beforeCoverage") : noRecords ? t("admin.stats.emptyRange") : null}
            modelMode={view === "model" && modelMode}
            onSelect={chooseBucket}
          />
          {(noRecords || beforeCoverage) && !overviewLoading ? null : overviewLoading ? null : <div className="usage-stats-share-list">
            {view === "model" ? displayedModels.map(row => {
              const value = usageStatsMetricValue(row.metrics, metric, includeCacheRead);
              const name = row.attribution === "provider"
                ? (row.provider === "unknown" ? t("admin.stats.unknownProvider") : formatUsageStatsProviderLabel(row.provider))
                : (row.model || row.model_label ? formatUsageStatsModelLabel(row.model, row.model_label) : t("admin.stats.unknownModel"));
              const isProviderRow = row.attribution === "provider";
              const seriesKey = usageStatsSeriesKey(row.provider, row.model, modelMode);
              return <UsageShareRow
                key={seriesKey}
                name={name}
                value={usageValue(row.metrics, row.coverage, metric, true, includeCacheRead, t, locale)}
                share={shareFor(value, providerKnownTotal)}
                color={providerChartSeries.find(item => item.key === seriesKey)?.color}
                onClick={isProviderRow ? () => changeFilter(usageStatsFilterKey("provider", row.provider, null)) : undefined}
              />;
            }) : displayedProjects.map(row => {
              const value = usageStatsMetricValue(row.metrics, metric, includeCacheRead);
              const selectable = row.project_id !== "__other__";
              return <UsageShareRow
                key={row.project_id ?? "unclassified"}
                name={projectLabel(row, t)}
                value={usageValue(row.metrics, row.coverage, metric, true, includeCacheRead, t, locale)}
                share={shareFor(value, projectKnownTotal)}
                color={row.project_id === null || row.project_id === "__other__"
                  ? "var(--v3-text-tertiary)"
                  : projectColors.get(row.project_id) ?? "var(--v3-text-tertiary)"}
                onClick={selectable ? () => changeProject(row.project_id ?? "__unclassified__") : undefined}
              />;
            })}
          </div>}
        </SettingsGroupBox>

        {period !== "all" && !noRecords && !beforeCoverage && !selectedNoRecords && !unknownEmptyRange ? <SettingsGroupBox title={t("admin.stats.inputBreakdown")}>
          {!selectedDate ? <p className="usage-stats-muted">{t("admin.stats.chooseDay")}</p> : detailLoading ? <FrameLoading inline label={t("admin.stats.loading")} /> : detail ? <InputMaterial detail={detail} /> : null}
        </SettingsGroupBox> : null}
      </>
    )}
  </div>;
}

function InputMaterial({ detail }: { detail: UsageStatsDayDetail }) {
  const { t, i18n } = useTranslation();
  const locale = intlLocale(resolveLanguage(i18n.resolvedLanguage, []));
  const material = detail.input_material;
  const rows = groupUsageStatsInputMaterial(material);
  return <div className="usage-stats-input-material">
    <p className="usage-stats-input-total" data-v3-selectable-content="true">{approximateTokens(material.observed_approximate_tokens, true, false, t, locale)}</p>
    <div className="usage-stats-share-list">
      {rows.map(row => <UsageShareRow
        key={row.category}
        name={t(`admin.stats.${row.category}`, { defaultValue: row.category })}
        value={approximateTokens(row.approximate_tokens, row.category === "harness_internal", row.partial, t, locale)}
        share={row.share}
        color={row.category === "harness_internal" ? undefined : "var(--v3-accent)"}
      />)}
    </div>
    <p className="usage-stats-input-meta" data-v3-selectable-content="true">{t("admin.stats.toolCalls", { count: detail.tool_calls.toLocaleString(locale) })}</p>
    {material.coverage.partial_samples > 0 || material.coverage.missing_samples > 0 ? <p className="usage-stats-input-meta" data-v3-selectable-content="true">{t("admin.stats.missingInput")}</p> : null}
  </div>;
}
