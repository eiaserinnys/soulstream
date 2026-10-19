import React, { createContext, useContext, useMemo, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { DisclosureIcon } from '../../DisclosureIcon';
import { GlassButton } from '../../GlassSurface';
import { SettingsOptionRow } from '../SettingsOptionRow';
import { SettingsSection } from '../SettingsSection';
import { SettingsSegmentedControl } from '../SettingsSegmentedControl';
import { useTokens } from '../../../theme';
import {
  buildEmptyUsageStatsOverview,
  buildUsageStatsDayDetail,
  buildUsageStatsOverview,
  USAGE_STATS_FIXTURE_ANCHOR,
  USAGE_STATS_PROVIDERS,
} from '../../../../../packages/soul-ui/src/lib/usage-stats-fixtures';
import {
  formatUsageStatsCoverage,
  formatUsageStatsDateWithWeekday,
  formatUsageStatsInputCategoryLabel,
  formatUsageStatsModelLabel,
  formatUsageStatsPeriodLabel,
  formatUsageStatsProviderLabel,
  formatUsageStatsTokenCount,
  formatUsageStatsUsd,
  shiftUsageStatsAnchor,
} from '../../../../../packages/soul-ui/src/lib/usage-stats-format';
import type {
  UsageStatsAggregate,
  UsageStatsPeriod,
  UsageStatsProvider,
  UsageStatsQuery,
  UsageStatsSeriesPoint,
} from '../../../../../packages/soul-ui/src/lib/usage-stats-fixture-data';
import { UsageShareRow } from './UsageShareRow';
import { UsageStackBucket, UsageStackSegment, UsageStackedBars } from './UsageStackedBars';

export type PreviewState = 'ready' | 'loading' | 'empty' | 'error' | 'forbidden' | 'backfilling';
type Measure = 'tokens' | 'cost';
type ModelFilter = { id: string; provider: UsageStatsProvider | null; model: string | null; label: string };
type PreviewContextValue = {
  state: PreviewState;
  setState(state: PreviewState): void;
  initialPeriod: UsageStatsPeriod;
  initialDate: string | null;
  initialMeasure: Measure;
};

const PreviewContext = createContext<PreviewContextValue | null>(null);

export function UsageStatsPreviewProvider({
  children,
  initialState = 'ready',
  initialPeriod = 'week',
  initialDate = null,
  initialMeasure = 'tokens',
}: {
  children: React.ReactNode;
  initialState?: PreviewState;
  initialPeriod?: UsageStatsPeriod;
  initialDate?: string | null;
  initialMeasure?: Measure;
}) {
  const [state, setState] = useState(initialState);
  return <PreviewContext.Provider value={{ state, setState, initialPeriod, initialDate, initialMeasure }}>{children}</PreviewContext.Provider>;
}

const SERIES_COLORS: Record<UsageStatsProvider, string> = {
  claude: '#cf7252',
  codex: '#5b8f78',
  antigravity: '#7f78c6',
  deepseek: '#4885bd',
  kimi: '#ba8b39',
};
const PROJECT_COLORS = ['#4987b5', '#5b9679', '#bd8055', '#8278b8', '#a36b89', '#88914b'];
const INPUT_COLORS = ['#5489bf', '#9674b5', '#55a08b', '#c2894e', '#8b8e94'];

const PERIOD_OPTIONS: { value: UsageStatsPeriod; label: string }[] = [
  { value: 'week', label: '주간' },
  { value: 'month', label: '월간' },
  { value: 'all', label: '전체' },
];
const MEASURE_OPTIONS: { value: Measure; label: string }[] = [
  { value: 'tokens', label: '토큰' },
  { value: 'cost', label: '정가' },
];

export function UsageStatsSettingsSection({ flattened = false }: { flattened?: boolean }) {
  const t = useTokens();
  const preview = useContext(PreviewContext);
  const state = preview?.state ?? 'ready';
  const setPreviewState = preview?.setState ?? (() => undefined);
  const [period, setPeriod] = useState<UsageStatsPeriod>(preview?.initialPeriod ?? 'week');
  const [anchor, setAnchor] = useState(USAGE_STATS_FIXTURE_ANCHOR);
  const [selectedDate, setSelectedDate] = useState<string | null>(preview?.initialDate ?? null);
  const [modelFilterId, setModelFilterId] = useState('all');
  const [projectIds, setProjectIds] = useState<string[]>([]);
  const [measure, setMeasure] = useState<Measure>(preview?.initialMeasure ?? 'tokens');
  const [metricsExpanded, setMetricsExpanded] = useState(false);
  const [basisExpanded, setBasisExpanded] = useState(false);

  const modelOptions = useMemo<ModelFilter[]>(() => {
    const options: ModelFilter[] = [{ id: 'all', provider: null, model: null, label: '모든 모델' }];
    for (const provider of USAGE_STATS_PROVIDERS) {
      options.push({ id: `provider:${provider}`, provider, model: null, label: formatUsageStatsProviderLabel(provider) });
      const providerOverview = buildUsageStatsOverview({ period, anchor, provider, model: null, project_ids: [] });
      for (const row of providerOverview.by_model) {
        if (!row.model) continue;
        options.push({
          id: `model:${provider}:${row.model}`,
          provider,
          model: row.model,
          label: `${formatUsageStatsProviderLabel(provider)} (${formatUsageStatsModelLabel(row.model)})`,
        });
      }
    }
    return options;
  }, [period, anchor]);
  const selectedModel = modelOptions.find(option => option.id === modelFilterId) ?? modelOptions[0];
  const query = useMemo<UsageStatsQuery>(() => ({
    period,
    anchor,
    provider: selectedModel.provider,
    model: selectedModel.model,
    project_ids: projectIds,
  }), [period, anchor, selectedModel, projectIds]);
  const overview = state === 'empty'
    ? buildEmptyUsageStatsOverview(query)
    : buildUsageStatsOverview(query);
  if (state === 'backfilling') overview.projection_status.state = 'backfilling';
  const selectedDetail = selectedDate ? buildUsageStatsDayDetail(selectedDate, query) : null;
  const activeAggregate: UsageStatsAggregate = selectedDetail?.totals ?? overview.totals;
  const activeMetrics = activeAggregate.metrics;
  const tokenValue = formatUsageStatsTokenCount(activeMetrics.total_tokens);
  const costValue = formatUsageStatsUsd(activeMetrics.reference_cost_usd);
  const mainValue = measure === 'tokens' ? tokenValue : costValue;
  const secondaryValue = measure === 'tokens' ? costValue : tokenValue;
  const coverageLabel = formatUsageStatsCoverage(activeAggregate.coverage.priced_total_tokens, activeMetrics.total_tokens);
  const baseOverview = useMemo(() => buildUsageStatsOverview({ period, anchor }), [period, anchor]);
  const modelPoints = overview.series.filter(point => point.provider !== undefined && point.project_id === undefined);
  const projectPoints = overview.series.filter(point => point.project_id !== undefined);
  const modelBuckets = useMemo(() => makeBuckets(modelPoints, period, measure, 'model'), [modelPoints, period, measure]);
  const projectBuckets = useMemo(() => makeBuckets(projectPoints, period, measure, 'project'), [projectPoints, period, measure]);
  const projectOptions = baseOverview.by_project
    .filter(row => row.project_id !== '__other__')
    .map(row => ({ id: row.project_id ?? '__unclassified__', label: row.label }));
  const denominator = sumKnown((selectedDetail?.by_model ?? overview.by_model).map(row => row.metrics[measure === 'tokens' ? 'total_tokens' : 'reference_cost_usd']));
  const projectDenominator = sumKnown((selectedDetail?.by_project ?? overview.by_project).map(row => row.metrics[measure === 'tokens' ? 'total_tokens' : 'reference_cost_usd']));
  const loading = state === 'loading';
  const unavailable = state === 'loading' || state === 'empty' || state === 'error' || state === 'forbidden';

  function changePeriod(nextPeriod: UsageStatsPeriod) {
    setPeriod(nextPeriod);
    setAnchor(USAGE_STATS_FIXTURE_ANCHOR);
    setSelectedDate(null);
  }

  function changeProject(id: string) {
    if (id === '__all__') {
      setProjectIds([]);
      return;
    }
    setProjectIds(current => current.includes(id) ? current.filter(value => value !== id) : [...current, id]);
  }

  function changeBucket(bucketId: string) {
    const bucketStart = bucketId.slice(bucketId.indexOf('-') + 1);
    if (period === 'all') {
      setPeriod('month');
      setAnchor(bucketStart);
      setSelectedDate(null);
      return;
    }
    setSelectedDate(current => current === bucketStart ? null : bucketStart);
  }

  function movePeriod(direction: number) {
    if (period === 'all') return;
    setAnchor(shiftUsageStatsAnchor(period, anchor, direction));
    setSelectedDate(null);
  }

  const periodLabel = formatUsageStatsPeriodLabel(period, overview.range.since, overview.range.until);
  const modelRows = selectedDetail?.by_model ?? overview.by_model;
  const projectRows = selectedDetail?.by_project ?? overview.by_project;
  const inputMaterial = selectedDetail?.input_material ?? null;

  return (
    <View testID="usage-stats-screen" style={{ gap: t.spacing.lg }}>
      <SettingsSection id="usage-stats-controls" title="기간과 필터" flattened={flattened}>
        <View style={{ gap: t.spacing.md }}>
          <SettingsSegmentedControl id="usage-stats-period" value={period} options={PERIOD_OPTIONS} onChange={changePeriod} />
          <View testID="usage-stats-date-row" style={{ flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm }}>
            <GlassButton iconOnly accessibilityLabel="이전 기간" disabled={period === 'all'} onPress={() => movePeriod(-1)}><Text style={{ ...t.foundation.typography.section, color: t.colors.accent }}>‹</Text></GlassButton>
            <Text testID="usage-stats-period-label" numberOfLines={1} style={{ flex: 1, ...t.foundation.typography.body, color: t.colors.textPrimary, textAlign: 'center' }}>{selectedDate ? formatUsageStatsDateWithWeekday(selectedDate) : periodLabel}</Text>
            <GlassButton iconOnly accessibilityLabel="다음 기간" disabled={period === 'all'} onPress={() => movePeriod(1)}><Text style={{ ...t.foundation.typography.section, color: t.colors.accent }}>›</Text></GlassButton>
            {selectedDate ? <GlassButton accessibilityLabel="기간 요약으로 돌아가기" onPress={() => setSelectedDate(null)}><Text style={{ ...t.foundation.typography.meta, color: t.colors.textPrimary }}>전체</Text></GlassButton> : null}
          </View>
          <SettingsOptionRow
            label="모델"
            selected={modelFilterId}
            options={modelOptions.map(option => ({ id: option.id, label: option.label }))}
            onSelect={setModelFilterId}
            emptyLabel="모델 없음"
          />
          <View style={{ gap: t.spacing.xs }}>
            <Text style={{ ...t.foundation.typography.meta, color: t.colors.textSecondary }}>프로젝트</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: t.spacing.xs }}>
              <ProjectFilterChip label="전체" selected={projectIds.length === 0} onPress={() => changeProject('__all__')} />
              {projectOptions.map(option => <ProjectFilterChip key={option.id} label={option.label} selected={projectIds.includes(option.id)} onPress={() => changeProject(option.id)} />)}
            </View>
          </View>
          <SettingsSegmentedControl<Measure> id="usage-stats-measure" value={measure} options={MEASURE_OPTIONS} onChange={setMeasure} />
        </View>
      </SettingsSection>

      {unavailable ? <StatusSection flattened={flattened} state={state} loading={loading} onRetry={() => setPreviewState('ready')} /> : null}
      {!unavailable ? <>
        {overview.projection_status.state === 'backfilling' ? <Text testID="usage-stats-backfilling" style={{ ...t.foundation.typography.meta, color: t.colors.textSecondary }}>일부 기간을 수집 중</Text> : null}
        <SettingsSection id="usage-stats-summary" title="요약" flattened={flattened}>
          <View style={{ gap: t.spacing.md }}>
            <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: t.spacing.sm }}>
              <Text testID={measure === 'cost' ? 'usage-stats-reference-cost' : 'usage-stats-total-tokens'} style={{ flex: 1, ...t.foundation.typography.display, color: t.colors.textPrimary, fontVariant: ['tabular-nums'] }}>{mainValue}</Text>
              <Text style={{ ...t.foundation.typography.meta, color: t.colors.textSecondary }}>{measure === 'tokens' ? '토큰' : '정가'}</Text>
            </View>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: t.spacing.sm }}>
              <Text testID={measure === 'tokens' ? 'usage-stats-reference-cost' : 'usage-stats-total-tokens'} style={{ ...t.foundation.typography.body, color: t.colors.textSecondary, fontVariant: ['tabular-nums'] }}>{measure === 'tokens' ? costValue : tokenValue}</Text>
              <Text style={{ ...t.foundation.typography.meta, color: t.colors.textSecondary }}>{coverageLabel}</Text>
              {activeAggregate.coverage.missing_usage_turns > 0 ? <Text testID="usage-stats-missing-turns" style={{ ...t.foundation.typography.meta, color: t.colors.textSecondary }}>미기록 턴 {activeAggregate.coverage.missing_usage_turns}</Text> : <Text testID="usage-stats-missing-turns">{null}</Text>}
            </View>
            <DisclosureButton label="토큰 구성" expanded={metricsExpanded} onPress={() => setMetricsExpanded(value => !value)} />
            {metricsExpanded ? <MetricBreakdown aggregate={activeAggregate} /> : null}
            <DisclosureButton label="집계 기준" expanded={basisExpanded} onPress={() => setBasisExpanded(value => !value)} />
            {basisExpanded ? <Text style={{ ...t.foundation.typography.meta, color: t.colors.textSecondary }}>KST 완료 기록 · 2026-10-19 API 기본 정가</Text> : null}
          </View>
        </SettingsSection>

        <SettingsSection id="usage-stats-models" title="모델" flattened={flattened}>
          <View style={{ gap: t.spacing.md }}>
            <UsageStackedBars testID="usage-stats-model-chart" buckets={modelBuckets} selectedBucket={selectedDate ? `day-${selectedDate}` : null} onSelectBucket={changeBucket} />
            <View style={{ gap: t.spacing.md }}>
              {modelRows.map(row => {
                const value = row.metrics[measure === 'tokens' ? 'total_tokens' : 'reference_cost_usd'];
                const share = typeof value === 'number' && denominator > 0 ? value / denominator : null;
                const label = row.model
                  ? `${formatUsageStatsProviderLabel(row.provider)} (${formatUsageStatsModelLabel(row.model)})`
                  : formatUsageStatsProviderLabel(row.provider);
                const id = row.model ? `usage-stats-model-row-${row.provider}-${row.model}` : `usage-stats-model-row-${row.provider}-provider`;
                const valueLabel = measure === 'tokens' ? formatUsageStatsTokenCount(value) : formatUsageStatsUsd(value);
                return <UsageShareRow key={`${row.provider}:${row.model ?? 'provider'}`} testID={id} label={label} value={valueLabel} share={share} color={SERIES_COLORS[row.provider]} />;
              })}
            </View>
          </View>
        </SettingsSection>

        <SettingsSection id="usage-stats-projects" title="프로젝트" flattened={flattened}>
          <View style={{ gap: t.spacing.md }}>
            <UsageStackedBars testID="usage-stats-project-chart" buckets={projectBuckets} />
            <View style={{ gap: t.spacing.md }}>
              {projectRows.map(row => {
                const value = row.metrics[measure === 'tokens' ? 'total_tokens' : 'reference_cost_usd'];
                const share = typeof value === 'number' && projectDenominator > 0 ? value / projectDenominator : null;
                const id = row.project_id === null ? 'unclassified' : row.project_id;
                return <UsageShareRow key={id} label={row.label} value={measure === 'tokens' ? formatUsageStatsTokenCount(value) : formatUsageStatsUsd(value)} share={share} color={projectColor(row.project_id)} />;
              })}
            </View>
          </View>
        </SettingsSection>

        <SettingsSection id="usage-stats-input" title="입력 자료" flattened={flattened}>
          <View style={{ gap: t.spacing.md }}>
            <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: t.spacing.sm }}>
              <Text style={{ flex: 1, ...t.foundation.typography.body, color: t.colors.textSecondary }}>관측 글자</Text>
              <Text testID="usage-stats-observed-chars" style={{ ...t.foundation.typography.cardTitle, color: t.colors.textPrimary, fontVariant: ['tabular-nums'] }}>{inputMaterial?.observed_chars === null || inputMaterial === null ? (inputMaterial ? '미기록' : '날짜 선택') : `${inputMaterial.observed_chars.toLocaleString('ko-KR')}자`}</Text>
            </View>
            {inputMaterial ? <>
              <Text style={{ ...t.foundation.typography.meta, color: t.colors.textSecondary }}>문자 수 기준 · 과금 토큰과 별도</Text>
              {inputMaterial.parts.map((part, index) => {
                const isHarness = part.category === 'harness_internal';
                const label = formatUsageStatsInputCategoryLabel(part.category);
                const value = isHarness ? '관측 안 됨' : part.chars === null ? '미기록' : `${part.chars.toLocaleString('ko-KR')}자`;
                return <UsageShareRow key={part.category} testID={isHarness ? 'usage-stats-input-harness-row' : undefined} valueTestID={isHarness ? 'usage-stats-input-harness' : undefined} label={label} value={value} share={isHarness ? null : part.share} color={INPUT_COLORS[index % INPUT_COLORS.length]} />;
              })}
              <Text style={{ ...t.foundation.typography.meta, color: t.colors.textSecondary }}>도구 호출 {selectedDetail?.tool_calls ?? 0}회 · 미기록 입력 {inputMaterial.coverage.missing_samples}건</Text>
            </> : <Text style={{ ...t.foundation.typography.meta, color: t.colors.textSecondary }}>날짜를 선택하면 그날의 입력 구성을 봅니다.</Text>}
          </View>
        </SettingsSection>
      </> : null}
    </View>
  );
}

function ProjectFilterChip({ label, selected, onPress }: { label: string; selected: boolean; onPress(): void }) {
  const t = useTokens();
  return <GlassButton accessibilityLabel={label} accessibilityState={{ selected }} onPress={onPress} contentStyle={selected ? { backgroundColor: t.colors.accentTint } : undefined}>
    <Text style={{ ...t.foundation.typography.meta, color: selected ? t.colors.textPrimary : t.colors.textSecondary }}>{label}</Text>
  </GlassButton>;
}

function StatusSection({ flattened, state, loading, onRetry }: { flattened: boolean; state: PreviewState; loading: boolean; onRetry(): void }) {
  const t = useTokens();
  const content = state === 'loading'
    ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm }}><ActivityIndicator /><Text style={{ ...t.foundation.typography.body, color: t.colors.textSecondary }}>불러오는 중</Text></View>
    : state === 'empty'
      ? <Text style={{ ...t.foundation.typography.body, color: t.colors.textSecondary }}>기록이 없습니다.</Text>
      : state === 'forbidden'
        ? <Text style={{ ...t.foundation.typography.body, color: t.colors.textSecondary }}>통계를 볼 권한이 없습니다.</Text>
        : <View style={{ gap: t.spacing.sm }}><Text style={{ ...t.foundation.typography.body, color: t.colors.textSecondary }}>통계를 불러오지 못했습니다.</Text><GlassButton disabled={loading} onPress={onRetry}><Text style={{ ...t.foundation.typography.body, color: t.colors.textPrimary }}>다시 불러오기</Text></GlassButton></View>;
  return <SettingsSection id="usage-stats-status" title="사용량" flattened={flattened}>{content}</SettingsSection>;
}

function DisclosureButton({ label, expanded, onPress }: { label: string; expanded: boolean; onPress(): void }) {
  const t = useTokens();
  return <GlassButton accessibilityLabel={label} accessibilityState={{ expanded }} onPress={onPress}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm }}><Text style={{ flex: 1, ...t.foundation.typography.body, color: t.colors.textPrimary }}>{label}</Text><DisclosureIcon expanded={expanded} /></View>
  </GlassButton>;
}

function MetricBreakdown({ aggregate }: { aggregate: UsageStatsAggregate }) {
  const t = useTokens();
  const metrics = aggregate.metrics;
  const rows = [
    ['입력 토큰', metrics.input_total],
    ['캐시 읽기', metrics.cache_read],
    ['캐시 쓰기', metrics.cache_write],
    ['출력 토큰', metrics.output_total],
    ['추론 출력 포함', metrics.reasoning_output],
  ] as const;
  return <View style={{ gap: t.spacing.xs }}>
    {rows.map(([label, value]) => <View key={label} style={{ flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm }}><Text style={{ flex: 1, ...t.foundation.typography.meta, color: t.colors.textSecondary }}>{label}</Text><Text style={{ ...t.foundation.typography.meta, color: t.colors.textPrimary, fontVariant: ['tabular-nums'] }}>{formatUsageStatsTokenCount(value, false)}</Text></View>)}
    <Text style={{ ...t.foundation.typography.meta, color: t.colors.textSecondary }}>캐시와 추론은 합계에 이미 포함</Text>
  </View>;
}

function makeBuckets(points: UsageStatsSeriesPoint[], period: UsageStatsPeriod, measure: Measure, kind: 'model' | 'project'): UsageStackBucket[] {
  const grouped: Record<string, UsageStackBucket> = {};
  for (const point of points) {
    const bucket = point.bucket_start;
    const identity = kind === 'model' ? `${point.provider}:${point.model ?? ''}` : `project:${point.project_id ?? '__unclassified__'}`;
    const label = period === 'all' ? point.bucket_start.slice(0, 7) : point.bucket_start.slice(5);
    if (!grouped[bucket]) grouped[bucket] = { id: `${period === 'all' ? 'month' : 'day'}-${bucket}`, label, segments: [] };
    const existing = grouped[bucket].segments.find(segment => segment.id === identity);
    const value = point.metrics[measure === 'tokens' ? 'total_tokens' : 'reference_cost_usd'];
    const color = kind === 'model'
      ? point.provider ? SERIES_COLORS[point.provider] : '#888888'
      : projectColor(point.project_id);
    if (existing) existing.value = (existing.value ?? 0) + (value ?? 0);
    else grouped[bucket].segments.push({ id: identity, label: point.label, value, color });
  }
  return Object.values(grouped);
}

function sumKnown(values: (number | null)[]): number {
  return values.reduce<number>((sum, value) => sum + (typeof value === 'number' ? value : 0), 0);
}

function projectColor(projectId: string | null | undefined): string {
  const key = projectId ?? '__unclassified__';
  let hash = 0;
  for (let index = 0; index < key.length; index += 1) hash = (hash * 31 + key.charCodeAt(index)) | 0;
  return PROJECT_COLORS[Math.abs(hash) % PROJECT_COLORS.length];
}
