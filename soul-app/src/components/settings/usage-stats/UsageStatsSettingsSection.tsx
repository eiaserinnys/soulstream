import React, { createContext, useContext, useMemo, useState } from 'react';
import { ActivityIndicator, Linking, Text, View } from 'react-native';
import { BackendNodeCardHeader } from '../BackendNodeCard';
import { useSettingsWorkspace } from '../SettingsWorkspaceContext';
import { USAGE_STATS_FIXTURE_ANCHOR, USAGE_STATS_FIXTURE_AS_OF } from '../../../../../packages/soul-ui/src/lib/usage-stats-fixture-data';
import { GlassButton } from '../../GlassSurface';
import { SettingsOptionRow } from '../SettingsOptionRow';
import { SettingsSection } from '../SettingsSection';
import { SettingsSegmentedControl } from '../SettingsSegmentedControl';
import { useTokens } from '../../../theme';
import {
  formatUsageStatsCoverage,
  formatUsageStatsDateWithWeekday,
  formatUsageStatsInputCategoryLabel,
  formatUsageStatsModelLabel,
  formatUsageStatsPeriodLabel,
  formatUsageStatsProviderLabel,
  formatUsageStatsTokenCount,
  shiftUsageStatsAnchor,
  usageStatsMonthAnchor,
  usageStatsRange,
  usageStatsModelColorIndex,
  USAGE_STATS_LABELS,
  formatUsageStatsValue,
  formatUsageStatsApproximateTokens,
} from '../../../../../packages/soul-ui/src/lib/usage-stats-format';
import type {
  UsageStatsAggregate,
  UsageStatsPeriod,
  UsageStatsProvider,
  UsageStatsQuery,
} from '../../../../../packages/soul-ui/src/lib/usage-stats-fixture-data';
import { UsageShareRow } from './UsageShareRow';
import { makeUsageStatsBuckets, sumKnown } from './usage-stats-chart-data';
import { UsageStackedBars } from './UsageStackedBars';
import { useUsageStats, type UsageStatsLoadState } from './useUsageStats';

type Measure = 'tokens' | 'cost';
type ModelFilter = { id: string; provider: UsageStatsProvider | null; model: string | null; label: string };
type PreviewContextValue = {
  initialPeriod: UsageStatsPeriod;
  initialAnchor: string;
  initialDate: string | null;
  initialMeasure: Measure;
};

const PreviewContext = createContext<PreviewContextValue | null>(null);

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

export function UsageStatsPreviewProvider({
  children,
  initialPeriod = 'week',
  initialAnchor = USAGE_STATS_FIXTURE_ANCHOR,
  initialDate = null,
  initialMeasure = 'tokens',
}: {
  children: React.ReactNode;
  initialPeriod?: UsageStatsPeriod;
  initialAnchor?: string;
  initialDate?: string | null;
  initialMeasure?: Measure;
}) {
  return <PreviewContext.Provider value={{ initialPeriod, initialAnchor, initialDate, initialMeasure }}>{children}</PreviewContext.Provider>;
}

export function UsageStatsSettingsSection({ flattened = false }: { flattened?: boolean }) {
  const t = useTokens();
  const preview = useContext(PreviewContext);
  const workspace = useSettingsWorkspace();
  const [period, setPeriod] = useState<UsageStatsPeriod>(preview?.initialPeriod ?? 'week');
  const [anchor, setAnchor] = useState(() => preview?.initialAnchor ?? new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' }));
  const [selectedDate, setSelectedDate] = useState<string | null>(preview?.initialDate ?? null);
  const [modelFilterId, setModelFilterId] = useState('all');
  const [projectIds, setProjectIds] = useState<string[]>([]);
  const [measure, setMeasure] = useState<Measure>(preview?.initialMeasure ?? 'tokens');
  const [view, setView] = useState<'model' | 'project'>('model');
  const [metricsExpanded, setMetricsExpanded] = useState(false);
  const [basisExpanded, setBasisExpanded] = useState(false);

  const [, provider = null, model = null] = modelFilterId.split(':') as [string, UsageStatsProvider?, string?];
  const query = useMemo<UsageStatsQuery>(() => ({
    period, anchor, provider, model, project_ids: projectIds,
  }), [period, anchor, provider, model, projectIds]);
  const { overview, detail: selectedDetail, baseOverview, allOverview, modelOverviews, state, retry } = useUsageStats(query, selectedDate);
  const modelOptions: ModelFilter[] = (() => {
    const options: ModelFilter[] = [{ id: 'all', provider: null, model: null, label: '모든 모델' }];
    for (const [index, provider] of (['claude', 'codex', 'antigravity', 'deepseek', 'kimi'] as const).entries()) {
      options.push({ id: `provider:${provider}`, provider, model: null, label: formatUsageStatsProviderLabel(provider) });
      for (const row of modelOverviews[index]?.by_model ?? []) {
        if (!row.model) continue;
        options.push({
          id: `model:${provider}:${row.model}`,
          provider,
          model: row.model,
          label: formatUsageStatsModelLabel(row.model),
        });
      }
    }
    return options;
  })();
  const range = state === 'ready' && overview ? overview.range : usageStatsRange(period, anchor, USAGE_STATS_FIXTURE_AS_OF, '2026-09-01');
  const coveredSince = allOverview?.projection_status.covered_since ?? '2026-09-01';
  const beforeCoverage = range.effective_until <= coveredSince;
  const selectedModel = { provider, model };
  const emptyData = overview?.series.length === 0 && overview.totals.metrics.total_tokens === 0;
  const activeDate = emptyData ? null : selectedDate;
  const activeAggregate = selectedDetail?.totals ?? overview?.totals ?? null;
  const tokenValue = activeAggregate ? formatUsageStatsValue(activeAggregate.metrics, activeAggregate.coverage, 'tokens') : '미기록';
  const costValue = activeAggregate ? formatUsageStatsValue(activeAggregate.metrics, activeAggregate.coverage, 'cost') : '미확인';
  const coverageLabel = activeAggregate ? formatUsageStatsCoverage(activeAggregate.coverage.priced_total_tokens, activeAggregate.metrics.total_tokens) : '';
  const modelPoints = overview?.series.filter(point => point.provider !== undefined && point.project_id === undefined) ?? [];
  const projectPoints = overview?.series.filter(point => point.project_id !== undefined) ?? [];
  const nodeColors = t.mode === 'dark' ? NODE_COLORS.dark : NODE_COLORS.light;
  const seriesColors: Record<UsageStatsProvider, string> = {
    claude: nodeColors.intervention,
    codex: nodeColors.response,
    antigravity: nodeColors.user,
    deepseek: nodeColors.thinking,
    kimi: nodeColors.plan,
  };
  const projectPalette = [nodeColors.user, nodeColors.response, nodeColors.tool, nodeColors.thinking, nodeColors.plan];
  const projectColorById = (() => {
    const result: Record<string, string> = {};
    let rank = 0;
    for (const row of baseOverview?.by_project ?? []) {
      if (!row.project_id || row.project_id === '__other__') continue;
      if (rank < projectPalette.length) result[row.project_id] = projectPalette[rank];
      rank += 1;
    }
    return result;
  })();
  const modelRoster = modelOverviews.find(data => data.by_model[0]?.provider === provider)?.by_model.map(row => row.model) ?? [];
  const modelColorById: Record<string, string> = {};
  for (const model of modelRoster) {
    if (model) modelColorById[model] = projectPalette[usageStatsModelColorIndex(model, modelRoster)] ?? t.colors.textTertiary;
  }
  const modelBuckets = makeUsageStatsBuckets(modelPoints, period, range, measure, 'model', seriesColors, projectColorById, t.colors.textTertiary, coveredSince, emptyData, provider ? modelColorById : undefined);
  const projectBuckets = makeUsageStatsBuckets(projectPoints, period, range, measure, 'project', seriesColors, projectColorById, t.colors.textTertiary, coveredSince, emptyData);
  const projectOptions = [
    { id: 'all', label: '모든 프로젝트' },
    ...(baseOverview?.by_project ?? [])
      .filter(row => row.project_id !== '__other__')
      .map(row => ({ id: row.project_id ?? '__unclassified__', label: row.label })),
  ];
  const selectedProject = projectIds[0] ?? 'all';
  const modelRows = selectedDetail?.by_model ?? overview?.by_model ?? [];
  const projectRows = selectedDetail?.by_project ?? overview?.by_project ?? [];
  const inputMaterial = selectedDetail?.input_material ?? null;
  const denominator = sumKnown(modelRows.map(row => row.metrics[measure === 'tokens' ? 'total_tokens' : 'reference_cost_usd']));
  const projectDenominator = sumKnown(projectRows.map(row => row.metrics[measure === 'tokens' ? 'total_tokens' : 'reference_cost_usd']));
  const loading = state === 'loading';
  const unavailable = state !== 'ready' || !overview || !baseOverview || !allOverview;
  const previousDisabled = period === 'all' || !allOverview || range.since <= coveredSince;
  const nextDisabled = period === 'all' || !allOverview || range.until >= allOverview.as_of.slice(0, 10);
  const periodLabel = formatUsageStatsPeriodLabel(period, range.since, range.until);

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
          selected={modelFilterId}
          options={modelOptions.map(option => ({ id: option.id, label: option.label }))}
          onSelect={id => { setModelFilterId(id); setSelectedDate(null); }}
          emptyLabel="모델 없음"
        />
        <SettingsOptionRow
          pickerMode="picker"
          label="프로젝트"
          selected={selectedProject}
          options={projectOptions}
          onSelect={id => { setProjectIds(id === 'all' ? [] : [id]); setSelectedDate(null); }}
          emptyLabel="프로젝트 없음"
        />
      </View>

      {unavailable ? <StatusSection flattened={flattened} state={state} loading={loading} onRetry={retry} /> : null}
      {!unavailable && overview && activeAggregate ? <>
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
              </View>
              <View style={{ flex: 1, minWidth: 0, gap: t.spacing.xs }}>
                <Text style={{ ...t.foundation.typography.meta, color: t.colors.textTertiary }}>정가</Text>
                <Text testID="usage-stats-reference-cost" numberOfLines={1} style={{ ...t.foundation.typography.section, color: t.colors.textPrimary, fontVariant: ['tabular-nums'] }}>{costValue}</Text>
              </View>
            </View>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: t.spacing.sm }}>
              {coverageLabel ? <Text style={{ ...t.foundation.typography.meta, color: t.colors.textSecondary }}>{coverageLabel}</Text> : null}
              {activeAggregate.coverage.missing_usage_turns > 0 ? <Text testID="usage-stats-missing-turns" style={{ ...t.foundation.typography.meta, color: t.colors.textSecondary }}>미기록 턴 {activeAggregate.coverage.missing_usage_turns}</Text> : null}
            </View>
            <DisclosureButton label={USAGE_STATS_LABELS.tokenDetails} expanded={metricsExpanded} onPress={() => setMetricsExpanded(value => !value)} />
            {metricsExpanded ? <MetricBreakdown aggregate={activeAggregate} /> : null}
            <DisclosureButton label="집계 기준" expanded={basisExpanded} onPress={() => setBasisExpanded(value => !value)} />
            {basisExpanded ? <AggregationBasis /> : null}
            <View testID="usage-stats-models" style={{ gap: t.spacing.md }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm }}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <SettingsOptionRow label="보기" pickerMode="picker" selected={view}
                    options={[{ id: 'model', label: '모델별' }, { id: 'project', label: '프로젝트별' }]}
                    onSelect={value => setView(value as 'model' | 'project')} emptyLabel="보기 없음" />
                </View>
                <SettingsSegmentedControl<Measure> id="usage-stats-measure" value={measure} options={MEASURE_OPTIONS} onChange={setMeasure} wrap />
              </View>
              <UsageStackedBars
                testID={view === 'model' ? 'usage-stats-model-chart' : 'usage-stats-project-chart'}
                buckets={view === 'model' ? modelBuckets : projectBuckets}
                selectedBucket={activeDate ? `day-${activeDate}` : null}
                onSelectBucket={bucketId => changeBucket(bucketId, false)}
                onDragBucket={period === 'all' ? undefined : bucketId => changeBucket(bucketId, true)}
                measure={measure}
              />
              <View style={{ gap: t.spacing.md }}>
                {!emptyData && !beforeCoverage ? view === 'model' ? modelRows.map(row => {
                  const value = row.metrics[measure === 'tokens' ? 'total_tokens' : 'reference_cost_usd'];
                  const share = typeof value === 'number' && denominator > 0 ? value / denominator : value === 0 ? 0 : null;
                  const label = row.model ? formatUsageStatsModelLabel(row.model) : formatUsageStatsProviderLabel(row.provider);
                  const id = row.model ? `usage-stats-model-row-${row.provider}-${row.model}` : `usage-stats-model-row-${row.provider}-provider`;
                  return <UsageShareRow
                    key={`${row.provider}:${row.model ?? 'provider'}`}
                    testID={id}
                    label={label}
                    value={formatUsageStatsValue(row.metrics, row.coverage, measure, true)}
                    share={share}
                    color={provider ? (row.model ? modelColorById[row.model] : undefined) ?? t.colors.textTertiary : seriesColors[row.provider]}
                    onPress={!selectedModel.provider && !row.model ? () => {
                      setModelFilterId(`provider:${row.provider}`);
                      setSelectedDate(null);
                    } : undefined}
                  />;
                }) : projectRows.map(row => {
                  const value = row.metrics[measure === 'tokens' ? 'total_tokens' : 'reference_cost_usd'];
                  const share = typeof value === 'number' && projectDenominator > 0 ? value / projectDenominator : value === 0 ? 0 : null;
                  const id = row.project_id === null ? '__unclassified__' : row.project_id;
                  return <UsageShareRow
                    key={id}
                    testID={`usage-stats-project-row-${id}`}
                    label={row.label}
                    value={formatUsageStatsValue(row.metrics, row.coverage, measure, true)}
                    share={share}
                    color={projectColorById[id] ?? t.colors.textTertiary}
                    onPress={row.project_id === '__other__' ? undefined : () => {
                      setProjectIds([id]);
                      setSelectedDate(null);
                    }}
                  />;
                }) : null}
              </View>
            </View>
          </View>
        </SettingsSection>

        {!emptyData && !beforeCoverage && period !== 'all' ? <SettingsSection id="usage-stats-input" title="입력 자료 구성" flattened={flattened}>
          <View style={{ gap: t.spacing.md, padding: t.cardLayout.padding }}>
            {workspace ? <Text style={{ ...t.foundation.typography.body, color: t.colors.textPrimary, fontWeight: '700' }}>입력 자료 구성</Text> : null}
            {inputMaterial ? <>
              <Text testID="usage-stats-observed-tokens" style={{ ...t.foundation.typography.cardTitle, color: t.colors.textPrimary, fontVariant: ['tabular-nums'] }}>{formatUsageStatsApproximateTokens(inputMaterial.observed_approximate_tokens, true)}</Text>
              {inputMaterial.parts.map((part, index) => {
                const isHarness = part.category === 'harness_internal';
                const label = formatUsageStatsInputCategoryLabel(part.category);
                const value = isHarness ? '관측 안 됨' : formatUsageStatsApproximateTokens(part.approximate_tokens);
                return <UsageShareRow key={`${part.category}:${part.source_key ?? index}`} testID={isHarness ? 'usage-stats-input-harness-row' : undefined} valueTestID={isHarness ? 'usage-stats-input-harness' : undefined} label={label} value={value} share={isHarness ? null : part.share} color={t.colors.accent} />;
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

function DisclosureButton({ label, expanded, onPress }: { label: string; expanded: boolean; onPress(): void }) {
  const t = useTokens();
  return <BackendNodeCardHeader accessibilityLabel={label} expanded={expanded} onPress={onPress}>
    <Text style={{ ...t.foundation.typography.body, color: t.colors.textPrimary }}>{label}</Text>
  </BackendNodeCardHeader>;
}

function MetricBreakdown({ aggregate }: { aggregate: UsageStatsAggregate }) {
  const t = useTokens();
  const metrics = aggregate.metrics;
  const rows = [
    [USAGE_STATS_LABELS.input, metrics.input_total],
    [USAGE_STATS_LABELS.cacheRead, metrics.cache_read],
    [USAGE_STATS_LABELS.cacheWrite, metrics.cache_write],
    [USAGE_STATS_LABELS.output, metrics.output_total],
    [USAGE_STATS_LABELS.reasoning, metrics.reasoning_output],
  ] as const;
  return <View style={{ gap: t.spacing.xs }}>
    {rows.map(([label, value]) => <View key={label} style={{ flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm }}><Text style={{ flex: 1, ...t.foundation.typography.meta, color: t.colors.textSecondary }}>{label}</Text><Text style={{ ...t.foundation.typography.meta, color: t.colors.textPrimary, fontVariant: ['tabular-nums'] }}>{formatUsageStatsTokenCount(value, false)}</Text></View>)}
  </View>;
}

function AggregationBasis() {
  const t = useTokens();
  const style = { ...t.foundation.typography.meta, color: t.colors.textSecondary };
  return <View style={{ gap: t.spacing.xs }}>
    <Text style={style}>2026-10-19 공개 API 정가 USD 환산(standard, 기본 컨텍스트). 구독 실지출 아님</Text>
    <Text style={style}>단가 출처: {[
      ['OpenAI', 'https://developers.openai.com/api/docs/pricing?tab=suite'],
      ['Claude', 'https://platform.claude.com/docs/en/about-claude/pricing'],
      ['Gemini', 'https://ai.google.dev/gemini-api/docs/pricing'],
      ['DeepSeek', 'https://api-docs.deepseek.com/quick_start/pricing/'],
      ['Kimi', 'https://platform.kimi.ai/docs/pricing/chat'],
    ].map(([label, url], index) => <Text key={label} accessibilityRole="link" onPress={() => { void Linking.openURL(url); }} style={{ color: t.colors.accent }}>{index ? ', ' : ''}{label}</Text>)}</Text>
    <Text style={style}>날짜는 턴이 끝난 시각, Asia/Seoul, 주는 월요일 시작</Text>
    <Text style={style}>프로젝트는 지금 보이는 최상위 폴더 기준</Text>
    <Text style={style}>{USAGE_STATS_LABELS.inputEstimateBasis}</Text>
    <Text style={style}>{USAGE_STATS_LABELS.inputEstimateCaveat}</Text>
  </View>;
}
