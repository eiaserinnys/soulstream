import React, { useMemo, useState } from 'react';
import { ActivityIndicator, Platform, Text, View, type TextStyle } from 'react-native';
import { useSettingsWorkspace } from '../SettingsWorkspaceContext';
import { GlassButton } from '../../GlassSurface';
import { SettingsOptionRow } from '../SettingsOptionRow';
import { SettingsSection } from '../SettingsSection';
import { SettingsSegmentedControl } from '../SettingsSegmentedControl';
import { useTokens } from '../../../theme';
import {
  buildUsageStatsModelOptions,
  groupUsageStatsInputMaterial,
  usageStatsFilterKey,
  type UsageStatsModelOption,
} from '../../../../../packages/soul-ui/src/lib/usage-stats-presentation';
import {
  formatUsageStatsCoverage,
  formatUsageStatsDateWithWeekday,
  formatUsageStatsModelLabel,
  formatUsageStatsPeriodLabel,
  formatUsageStatsProviderLabel,
  formatUsageStatsCacheSplit,
  shiftUsageStatsAnchor,
  usageStatsCalendarRange,
  usageStatsKstDate,
  usageStatsMonthAnchor,
  usageStatsModelColorIndex,
  USAGE_STATS_LABELS,
  formatUsageStatsValue,
  formatUsageStatsApproximateTokens,
  usageStatsMetricValue,
} from '../../../../../packages/soul-ui/src/lib/usage-stats-format';
import type {
  UsageStatsPeriod,
  UsageStatsProvider,
  UsageStatsQuery,
} from '../../../../../packages/wire-schema/src/session_statistics';
import { UsageShareRow } from './UsageShareRow';
import { makeUsageStatsBuckets, sumKnown } from './usage-stats-chart-data';
import { UsageStackedBars } from './UsageStackedBars';
import { useUsageStats, type UsageStatsLoadState } from './useUsageStats';

type Measure = 'tokens' | 'cost';
type CacheReadSetting = 'exclude' | 'include';
type ProjectFilter = { id: string; label: string };
const ALL_MODEL_FILTER: UsageStatsModelOption = {
  id: usageStatsFilterKey('all', null, null),
  provider: null,
  model: null,
  label: '모든 모델',
};
const ALL_PROJECT_FILTER: ProjectFilter = { id: 'all', label: '모든 프로젝트' };
const UNCLASSIFIED_PROJECT_FILTER: ProjectFilter = { id: '__unclassified__', label: '미분류' };

const NODE_COLORS = {
  light: {
    user: '#3b82f6',
    response: '#10b981',
    thinking: '#8b5cf6',
    plan: '#06b6d4',
    tool: '#f59e0b',
    intervention: '#f97316',
  },
  dark: {
    user: 'hsl(217, 70%, 68%)',
    response: 'hsl(160, 60%, 52%)',
    thinking: 'hsl(258, 65%, 72%)',
    plan: 'hsl(189, 65%, 52%)',
    tool: 'hsl(38, 75%, 58%)',
    intervention: 'hsl(25, 70%, 60%)',
  },
} as const;

const PERIOD_OPTIONS: { value: UsageStatsPeriod; label: string }[] = [
  { value: 'week', label: '주간' },
  { value: 'month', label: '월간' },
  { value: 'all', label: '전체' },
];
const MEASURE_OPTIONS: { value: Measure; label: string }[] = [
  { value: 'tokens', label: '토큰' },
  { value: 'cost', label: '정가' },
];
const CACHE_READ_OPTIONS: { value: CacheReadSetting; label: string }[] = [
  { value: 'exclude', label: USAGE_STATS_LABELS.cacheReadExclude },
  { value: 'include', label: USAGE_STATS_LABELS.cacheReadInclude },
];

export function UsageStatsSettingsSection({ flattened = false }: { flattened?: boolean }) {
  const t = useTokens();
  const workspace = useSettingsWorkspace();
  const [period, setPeriod] = useState<UsageStatsPeriod>('week');
  const [anchor, setAnchor] = useState(() => usageStatsKstDate(Date.now()));
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [modelFilter, setModelFilter] = useState<UsageStatsModelOption>(ALL_MODEL_FILTER);
  const [projectFilter, setProjectFilter] = useState<ProjectFilter>(ALL_PROJECT_FILTER);
  const [measure, setMeasure] = useState<Measure>('tokens');
  const [includeCacheRead, setIncludeCacheRead] = useState(false);
  const [view, setView] = useState<'model' | 'project'>('model');

  const query = useMemo<UsageStatsQuery>(() => ({
    period,
    anchor,
    provider: modelFilter.provider,
    model: modelFilter.model,
    project_ids: projectFilter.id === 'all' ? [] : [projectFilter.id],
  }), [period, anchor, modelFilter.provider, modelFilter.model, projectFilter.id]);
  const { overview, detail: selectedDetail, state, retry } = useUsageStats(query, selectedDate);
  const provider = modelFilter.provider;
  const modelOptions = overview
    ? buildUsageStatsModelOptions(overview.options).map(option => option.provider === null && option.model === null
      ? { ...option, label: ALL_MODEL_FILTER.label }
      : option)
    : [ALL_MODEL_FILTER];
  if (!modelOptions.some(option => option.id === modelFilter.id)) modelOptions.push(modelFilter);
  const projectOptions = [
    ALL_PROJECT_FILTER,
    ...(overview?.options.projects ?? []).map(project => ({ id: project.project_id, label: project.label })),
    UNCLASSIFIED_PROJECT_FILTER,
  ];
  if (projectFilter.id !== 'all' && !projectOptions.some(option => option.id === projectFilter.id)) {
    projectOptions.push(projectFilter);
  }
  const range = overview?.range ?? null;
  const coveredSince = overview?.projection_status.covered_since ?? '';
  const hasPositiveKnown = Boolean(overview && (
    (typeof overview.totals.metrics.total_tokens === 'number' && overview.totals.metrics.total_tokens > 0)
      || (typeof overview.totals.metrics.reference_cost_usd === 'number' && overview.totals.metrics.reference_cost_usd > 0)
      || overview.series.some(point =>
    (typeof point.metrics.total_tokens === 'number' && point.metrics.total_tokens > 0)
      || (typeof point.metrics.reference_cost_usd === 'number' && point.metrics.reference_cost_usd > 0),
      )
  ));
  const beforeCoverage = Boolean(range && range.effective_until <= coveredSince && !hasPositiveKnown);
  const emptyData = Boolean(overview && overview.series.length === 0 && overview.totals.metrics.total_tokens === 0);
  const unknownEmptyRange = Boolean(overview && overview.series.length === 0 && overview.totals.metrics.total_tokens === null);
  const activeDate = selectedDate;
  const activeAggregate = selectedDate
    ? selectedDetail?.totals ?? null
    : overview?.totals ?? null;
  const cacheSplit = formatUsageStatsCacheSplit(activeAggregate?.metrics, activeAggregate?.coverage);
  const detailLoading = selectedDate !== null && !selectedDetail && state === 'loading';
  const tokenValue = detailLoading
    ? '불러오는 중…'
    : activeAggregate ? formatUsageStatsValue(activeAggregate.metrics, activeAggregate.coverage, 'tokens') : '미기록';
  const costValue = detailLoading
    ? '불러오는 중…'
    : activeAggregate ? formatUsageStatsValue(activeAggregate.metrics, activeAggregate.coverage, 'cost', false, true) : '미확인';
  const coverageLabel = activeAggregate
    ? formatUsageStatsCoverage(
      activeAggregate.coverage.priced_total_tokens,
      activeAggregate.metrics.provider_total_tokens,
      activeAggregate.coverage.token_partials.provider_total_tokens,
    )
    : '';
  const modelPoints = overview?.series.filter(point => point.provider !== undefined && point.project_id === undefined) ?? [];
  const projectPoints = overview?.series.filter(point => point.project_id !== undefined) ?? [];
  const modelChartPoints = modelPoints.map(point => {
    const value = usageStatsMetricValue(point.metrics, measure, includeCacheRead);
    return measure === 'tokens'
      ? { ...point, metrics: { ...point.metrics, total_tokens: value } }
      : { ...point, metrics: { ...point.metrics, reference_cost_usd: value } };
  });
  const projectChartPoints = projectPoints.map(point => {
    const value = usageStatsMetricValue(point.metrics, measure, includeCacheRead);
    return measure === 'tokens'
      ? { ...point, metrics: { ...point.metrics, total_tokens: value } }
      : { ...point, metrics: { ...point.metrics, reference_cost_usd: value } };
  });
  const completeEmptyRange = Boolean(overview
    && overview.totals.metrics.total_tokens === 0
    && overview.totals.metrics.reference_cost_usd === 0
    && !overview.totals.is_partial);
  const chartEmptyMessage = completeEmptyRange
    ? USAGE_STATS_LABELS.emptyRange
    : measure === 'tokens' ? USAGE_STATS_LABELS.missingUsage : USAGE_STATS_LABELS.unknownPrice;
  const nodeColors = t.mode === 'dark' ? NODE_COLORS.dark : NODE_COLORS.light;
  const seriesColors: Record<UsageStatsProvider, string> = {
    claude: nodeColors.intervention,
    codex: nodeColors.response,
    antigravity: nodeColors.user,
    deepseek: nodeColors.thinking,
    kimi: nodeColors.plan,
    unknown: t.colors.textTertiary,
  };
  const projectPalette = [nodeColors.user, nodeColors.response, nodeColors.tool, nodeColors.thinking, nodeColors.plan];
  const projectColorById = (() => {
    const result: Record<string, string> = {};
    const roster = overview?.options.project_roster ?? [];
    for (const project of overview?.options.projects ?? []) {
      const index = roster.indexOf(project.project_id);
      result[project.project_id] = index >= 0 ? projectPalette[index] ?? t.colors.textTertiary : t.colors.textTertiary;
    }
    return result;
  })();
  const modelRoster = overview?.options.model_rosters.find(roster => roster.provider === provider)?.models ?? [];
  const modelColorById: Record<string, string> = {};
  for (const model of modelRoster) {
    if (model === null || provider === 'unknown') continue;
    const colorIndex = usageStatsModelColorIndex(model, modelRoster);
    if (colorIndex >= 0) modelColorById[model] = projectPalette[colorIndex] ?? t.colors.textTertiary;
  }
  const modelBuckets = overview && range
    ? makeUsageStatsBuckets(modelChartPoints, period, range, measure, 'model', seriesColors, projectColorById, t.colors.textTertiary, coveredSince, provider ? modelColorById : undefined)
    : [];
  const projectBuckets = overview && range
    ? makeUsageStatsBuckets(projectChartPoints, period, range, measure, 'project', seriesColors, projectColorById, t.colors.textTertiary, coveredSince)
    : [];
  const modelRows = selectedDate ? selectedDetail?.by_model ?? [] : overview?.by_model ?? [];
  const projectRows = selectedDate ? selectedDetail?.by_project ?? [] : overview?.by_project ?? [];
  const inputMaterial = selectedDetail?.input_material ?? null;
  const inputRows = inputMaterial ? groupUsageStatsInputMaterial(inputMaterial) : [];
  const denominator = sumKnown(modelRows.map(row => usageStatsMetricValue(row.metrics, measure, includeCacheRead)));
  const projectDenominator = sumKnown(projectRows.map(row => usageStatsMetricValue(row.metrics, measure, includeCacheRead)));
  const loading = state === 'loading';
  const unavailable = !overview || state === 'error' || state === 'forbidden';
  const previousDisabled = period === 'all' || !range || range.since <= coveredSince;
  const nextDisabled = period === 'all' || !range || range.until > (overview ? usageStatsKstDate(overview.as_of) : '');
  const labelRange = range ?? (period === 'all' ? null : usageStatsCalendarRange(period, anchor));
  const periodLabel = period === 'all' ? '전체' : formatUsageStatsPeriodLabel(period, labelRange!.since, labelRange!.until);

  function changePeriod(nextPeriod: UsageStatsPeriod) {
    setPeriod(nextPeriod);
    setSelectedDate(null);
  }

  function changeBucket(bucketId: string, fromDrag: boolean) {
    const bucketStart = bucketId.slice(bucketId.indexOf('-') + 1);
    if (period === 'all') {
      setPeriod('month');
      setAnchor(usageStatsMonthAnchor(bucketStart, overview!.as_of));
      setSelectedDate(null);
      return;
    }
    if (fromDrag) setSelectedDate(bucketStart);
    else setSelectedDate(current => current === bucketStart ? null : bucketStart);
  }

  function movePeriod(direction: number) {
    if (period === 'all') return;
    setAnchor(current => shiftUsageStatsAnchor(period, current, direction));
    setSelectedDate(null);
  }

  function selectModelFilter(id: string) {
    const selected = modelOptions.find(option => option.id === id);
    if (!selected) return;
    setModelFilter(selected);
    setSelectedDate(null);
  }

  function selectProjectFilter(id: string) {
    const selected = projectOptions.find(option => option.id === id);
    if (!selected) return;
    setProjectFilter(selected);
    setSelectedDate(null);
  }

  return (
    <View testID="usage-stats-screen" style={{ gap: t.spacing.lg }}>
      <View testID="usage-stats-controls" style={{ gap: t.spacing.md }}>
        <SettingsSegmentedControl id="usage-stats-period" value={period} options={PERIOD_OPTIONS} onChange={changePeriod} />
        <View testID="usage-stats-date-row" style={{ flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm }}>
          {period !== 'all' ? <GlassButton iconOnly variant="plain" borderRadius={t.foundation.radius.round} accessibilityLabel="이전 기간" disabled={previousDisabled} onPress={() => movePeriod(-1)}><Text style={{ ...t.foundation.typography.section, color: t.colors.accent }}>‹</Text></GlassButton> : null}
          <Text testID="usage-stats-period-label" numberOfLines={1} style={{ flex: 1, ...t.foundation.typography.body, color: t.colors.textPrimary, textAlign: 'center' }}>{periodLabel}</Text>
          {period !== 'all' ? <GlassButton iconOnly variant="plain" borderRadius={t.foundation.radius.round} accessibilityLabel="다음 기간" disabled={nextDisabled} onPress={() => movePeriod(1)}><Text style={{ ...t.foundation.typography.section, color: t.colors.accent }}>›</Text></GlassButton> : null}
        </View>
        <SettingsOptionRow
          pickerMode="picker"
          label="모델"
          selected={modelFilter.id}
          options={modelOptions.map(option => ({ id: option.id, label: option.label }))}
          onSelect={selectModelFilter}
          emptyLabel="모델 없음"
        />
        <SettingsOptionRow
          pickerMode="picker"
          label="프로젝트"
          selected={projectFilter.id}
          options={projectOptions}
          onSelect={selectProjectFilter}
          emptyLabel="프로젝트 없음"
        />
      </View>

      {unavailable ? <StatusSection flattened={flattened} state={state} loading={loading} onRetry={retry} /> : null}
      {!unavailable && overview ? <>
        {overview.projection_status.state === 'backfilling' ? <Text testID="usage-stats-backfilling" style={{ ...t.foundation.typography.meta, color: t.colors.textSecondary }}>이전 기록 정리 중</Text> : null}
        <SettingsSection id="usage-stats-summary" title="요약" flattened={flattened}>
          <View style={{ gap: t.spacing.lg, padding: t.cardLayout.padding }}>
            {activeDate ? <GlassButton size="compact" style={{ alignSelf: 'flex-start' }} accessibilityLabel={`${formatUsageStatsDateWithWeekday(activeDate)} 선택 해제`} onPress={() => setSelectedDate(null)}>
              <Text style={{ ...t.foundation.typography.meta, color: t.colors.textPrimary }}>{formatUsageStatsDateWithWeekday(activeDate)} ×</Text>
            </GlassButton> : null}
            <View style={{ flexDirection: 'row', gap: t.spacing.md }}>
              <View style={{ flex: 1, minWidth: 0, gap: t.spacing.xs }}>
                <Text style={{ ...t.foundation.typography.meta, color: t.colors.textTertiary }}>토큰</Text>
                <Text testID="usage-stats-total-tokens" numberOfLines={1} style={{ ...t.foundation.typography.section, color: t.colors.textPrimary, fontVariant: ['tabular-nums'] }}>{tokenValue}</Text>
                <Text
                  testID="usage-stats-cache-read-excluded"
                  numberOfLines={2}
                  lineBreakStrategyIOS="hangul-word"
                  style={[
                    { ...t.foundation.typography.meta, color: t.colors.textTertiary },
                    Platform.OS === 'web' ? ({ wordBreak: 'keep-all' } as TextStyle) : undefined,
                  ]}
                >
                  {cacheSplit.cacheReadLine}
                </Text>
              </View>
              <View style={{ flex: 1, minWidth: 0, gap: t.spacing.xs }}>
                <Text style={{ ...t.foundation.typography.meta, color: t.colors.textTertiary }}>정가</Text>
                <Text testID="usage-stats-reference-cost" numberOfLines={1} style={{ ...t.foundation.typography.section, color: t.colors.textPrimary, fontVariant: ['tabular-nums'] }}>{costValue}</Text>
                <Text
                  testID="usage-stats-cache-read-cost-included"
                  numberOfLines={2}
                  lineBreakStrategyIOS="hangul-word"
                  style={[
                    { ...t.foundation.typography.meta, color: t.colors.textTertiary },
                    Platform.OS === 'web' ? ({ wordBreak: 'keep-all' } as TextStyle) : undefined,
                  ]}
                >
                  {cacheSplit.cacheReadCostLine}
                </Text>
              </View>
            </View>
            {coverageLabel || (activeAggregate?.coverage.missing_usage_turns ?? 0) > 0 ? (
              <View testID="usage-stats-summary-meta" style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: t.spacing.sm }}>
                {activeAggregate && activeAggregate.coverage.missing_usage_turns > 0 ? <Text testID="usage-stats-missing-turns" style={{ ...t.foundation.typography.meta, color: t.colors.textSecondary }}>미기록 턴 {activeAggregate.coverage.missing_usage_turns}</Text> : null}
                {coverageLabel ? <Text style={{ ...t.foundation.typography.meta, color: t.colors.textSecondary }}>{coverageLabel}</Text> : null}
              </View>
            ) : null}
            <View testID="usage-stats-models" style={{ gap: t.spacing.md }}>
              <View testID="usage-stats-view-measure-row" style={{ flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm }}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <SettingsOptionRow label="보기" pickerMode="picker" selected={view}
                    options={[{ id: 'model', label: '모델별' }, { id: 'project', label: '프로젝트별' }]}
                    onSelect={value => setView(value as 'model' | 'project')} emptyLabel="보기 없음" />
                </View>
                <SettingsSegmentedControl<Measure> id="usage-stats-measure" value={measure} options={MEASURE_OPTIONS} onChange={setMeasure} wrap />
              </View>
              <View testID="usage-stats-cache-read-row" style={{ flexDirection: 'row', justifyContent: 'flex-end' }}>
                <SettingsSegmentedControl<CacheReadSetting>
                  id="usage-stats-cache-read"
                  value={includeCacheRead ? 'include' : 'exclude'}
                  options={CACHE_READ_OPTIONS}
                  onChange={value => setIncludeCacheRead(value === 'include')}
                  wrap
                />
              </View>
              <UsageStackedBars
                testID={view === 'model' ? 'usage-stats-model-chart' : 'usage-stats-project-chart'}
                buckets={view === 'model' ? modelBuckets : projectBuckets}
                selectedBucket={activeDate ? `day-${activeDate}` : null}
                onSelectBucket={bucketId => changeBucket(bucketId, false)}
                onDragBucket={period === 'all' ? undefined : bucketId => changeBucket(bucketId, true)}
                measure={measure}
                emptyMessage={chartEmptyMessage}
              />
              <View style={{ gap: t.spacing.md }}>
                {!emptyData && !beforeCoverage ? detailLoading
                  ? <Text style={{ ...t.foundation.typography.body, color: t.colors.textSecondary }}>불러오는 중…</Text>
                  : view === 'model' ? modelRows.map(row => {
                  const value = usageStatsMetricValue(row.metrics, measure, includeCacheRead);
                  const share = typeof value === 'number' && denominator > 0 ? value / denominator : value === 0 ? 0 : null;
                  const label = row.attribution === 'provider'
                    ? formatUsageStatsProviderLabel(row.provider)
                    : formatUsageStatsModelLabel(row.model);
                  const id = row.model !== null ? `usage-stats-model-row-${row.provider}-${row.model}` : `usage-stats-model-row-${row.provider}-provider`;
                  return <UsageShareRow
                    key={JSON.stringify([row.provider, row.model])}
                    testID={id}
                    label={label}
                    value={formatUsageStatsValue(row.metrics, row.coverage, measure, true, includeCacheRead)}
                    share={share}
                    color={provider !== null ? (provider !== 'unknown' && row.model !== null ? modelColorById[row.model] : undefined) ?? t.colors.textTertiary : seriesColors[row.provider]}
                    onPress={modelFilter.provider === null && row.model === null ? () => {
                      const selected = modelOptions.find(option => option.provider === row.provider && option.model === null);
                      setModelFilter(selected ?? {
                        id: usageStatsFilterKey('provider', row.provider, null),
                        provider: row.provider,
                        model: null,
                        label: formatUsageStatsProviderLabel(row.provider),
                      });
                      setSelectedDate(null);
                    } : undefined}
                  />;
                }) : projectRows.map(row => {
                  const value = usageStatsMetricValue(row.metrics, measure, includeCacheRead);
                  const share = typeof value === 'number' && projectDenominator > 0 ? value / projectDenominator : value === 0 ? 0 : null;
                  const id = row.project_id === null ? '__unclassified__' : row.project_id;
                  return <UsageShareRow
                    key={id}
                    testID={`usage-stats-project-row-${id}`}
                    label={row.label}
                    value={formatUsageStatsValue(row.metrics, row.coverage, measure, true, includeCacheRead)}
                    share={share}
                    color={projectColorById[id] ?? t.colors.textTertiary}
                    onPress={row.project_id === '__other__' ? undefined : () => {
                      setProjectFilter(projectOptions.find(option => option.id === id) ?? { id, label: row.label });
                      setSelectedDate(null);
                    }}
                  />;
                }) : null}
              </View>
            </View>
          </View>
        </SettingsSection>

        {!emptyData && !beforeCoverage && !unknownEmptyRange && period !== 'all' ? <SettingsSection id="usage-stats-input" title="입력 자료 구성" flattened={flattened}>
          <View style={{ gap: t.spacing.md, padding: t.cardLayout.padding }}>
            {workspace ? <Text style={{ ...t.foundation.typography.body, color: t.colors.textPrimary, fontWeight: '700' }}>입력 자료 구성</Text> : null}
            {detailLoading
              ? <Text testID="usage-stats-observed-tokens" style={{ ...t.foundation.typography.meta, color: t.colors.textSecondary }}>불러오는 중…</Text>
              : inputMaterial ? <>
              <Text testID="usage-stats-observed-tokens" style={{ ...t.foundation.typography.cardTitle, color: t.colors.textPrimary, fontVariant: ['tabular-nums'] }}>{formatUsageStatsApproximateTokens(inputMaterial.observed_approximate_tokens, true)}</Text>
              {inputRows.map(row => {
                const isHarness = row.category === 'harness_internal';
                const value = isHarness ? '관측 안 됨' : formatUsageStatsApproximateTokens(row.approximate_tokens, false, row.partial);
                return <UsageShareRow key={row.category} testID={isHarness ? 'usage-stats-input-harness-row' : undefined} valueTestID={isHarness ? 'usage-stats-input-harness' : undefined} label={row.label} value={value} share={isHarness ? null : row.share} color={t.colors.accent} />;
              })}
              <Text style={{ ...t.foundation.typography.meta, color: t.colors.textSecondary }}>툴 호출 {selectedDetail?.tool_calls ?? 0}회</Text>
              {inputMaterial.coverage.missing_samples > 0 || inputMaterial.coverage.partial_samples > 0 ? <Text style={{ ...t.foundation.typography.meta, color: t.colors.textSecondary }}>{USAGE_STATS_LABELS.missingInput}</Text> : null}
            </> : <Text testID="usage-stats-observed-tokens" style={{ ...t.foundation.typography.meta, color: t.colors.textSecondary }}>막대에서 날짜를 고르세요</Text>}
          </View>
        </SettingsSection> : null}
      </> : null}
    </View>
  );
}

function StatusSection({ flattened, state, loading, onRetry }: { flattened: boolean; state: UsageStatsLoadState; loading: boolean; onRetry(): void }) {
  const t = useTokens();
  const content = state === 'loading'
    ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm }}><ActivityIndicator size="small" color={t.colors.accent} /><Text style={{ ...t.foundation.typography.body, color: t.colors.textSecondary }}>불러오는 중…</Text></View>
    : state === 'forbidden'
        ? <Text style={{ ...t.foundation.typography.body, color: t.colors.textSecondary }}>이 통계를 볼 권한이 없습니다.</Text>
        : <View style={{ gap: t.spacing.sm }}><Text style={{ ...t.foundation.typography.body, color: t.colors.textSecondary }}>통계를 불러오지 못했습니다.</Text><GlassButton disabled={loading} onPress={onRetry}><Text style={{ ...t.foundation.typography.body, color: t.colors.textPrimary }}>다시 불러오기</Text></GlassButton></View>;
  return <SettingsSection id="usage-stats-status" title="사용량" flattened={flattened}><View style={{ padding: t.cardLayout.padding }}>{content}</View></SettingsSection>;
}
