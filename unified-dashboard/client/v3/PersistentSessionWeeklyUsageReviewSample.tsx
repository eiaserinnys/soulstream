import { useState } from 'react';
import {
  DashboardIconCap,
  maxWeeklyUsageGaugeCount,
  nextUsageSummaryNodeId,
  selectUsageSummaryNode,
  weeklyUsageGauges,
  type UsageSummaryNode,
  type UsageSummaryProvider,
  type UsageSummarySnapshot,
} from '@seosoyoung/soul-ui';
import { Gauge, RefreshCw } from 'lucide-react';
import type { UseUsageSummaryResult } from '../hooks/useUsageSummary';
import { PersistentSessionWeeklyUsage } from './PersistentSessionWeeklyUsage';

type SampleState = 'normal' | 'loading' | 'pending' | 'empty' | 'error' | 'stale';
const evaluatedAtMs = 1_800_000_000_000;
const resetAt = evaluatedAtMs / 1000 + 4 * 24 * 60 * 60 + 2 * 60 * 60;

function provider(weeklyRemainingPercent: number, quotas: UsageSummaryProvider['quotas'] = []): UsageSummaryProvider {
  return { status: 'auto', weeklyRemainingPercent, weeklyResetAt: resetAt, shortRemainingPercent: null, shortResetAt: null, quotas };
}

function reviewNode(nodeId: string, providers: UsageSummaryNode['providers']): UsageSummaryNode {
  return { nodeId, fetchedAt: '2026-10-13T08:00:00.000Z', stale: false, staleSince: null, providers };
}

const threeGauges = reviewNode('node-a', {
  claude: provider(73, [{ id: 'claude:weekly_scoped:fable', label: 'Fable', window: '7d', model: 'Fable', remainingPercent: 41, resetAt }]),
  codex: provider(18),
  gemini: null,
});
const twoGauges = reviewNode('node-b', { claude: provider(66), codex: provider(42), gemini: null });
const noGauges = reviewNode('node-c', { claude: null, codex: null, gemini: null });
const summary: UsageSummarySnapshot = {
  generatedAt: '2026-10-13T08:00:00.000Z',
  collectedAt: null,
  nodes: [threeGauges, twoGauges, noGauges],
};
const stateLabels: Record<SampleState, string> = {
  normal: '정상', loading: '불러오는 중', pending: '수집 대기', empty: '주간 한도 없음', error: '조회 실패', stale: '갱신 지연',
};
const sampleStates: SampleState[] = ['normal', 'loading', 'pending', 'empty', 'error', 'stale'];

function resultFor(state: SampleState, selectedNodeId: string | null): UseUsageSummaryResult {
  const available = state === 'normal' || state === 'empty' || state === 'stale';
  const snapshot = available ? summary : null;
  const currentSelection = state === 'empty' ? 'node-c' : selectedNodeId;
  const node = selectUsageSummaryNode(snapshot, 'node-b', currentSelection);
  const loadState = state === 'pending' ? 'serverPending'
    : state === 'error' || state === 'stale' ? 'connectionError'
      : available ? 'ready' : 'idle';
  return {
    summary: snapshot,
    node: state === 'stale' && node ? { ...node, stale: true } : node,
    gauges: weeklyUsageGauges(node),
    maxGaugeCount: maxWeeklyUsageGaugeCount(snapshot),
    loading: state === 'loading',
    loadState,
    evaluatedAtMs,
    retry: () => undefined,
  };
}

export function PersistentSessionWeeklyUsageReviewSample() {
  const [enabled, setEnabled] = useState(true);
  const [sampleState, setSampleState] = useState<SampleState>('normal');
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const usage = resultFor(sampleState, selectedNodeId);
  const nextNode = () => setSelectedNodeId(nextUsageSummaryNodeId(usage.summary, usage.node?.nodeId ?? null));
  const changeState = () => {
    setSampleState(current => sampleStates[(sampleStates.indexOf(current) + 1) % sampleStates.length]!);
    setSelectedNodeId(null);
  };

  return <div className="persistent-session-weekly-usage-review-sample">
    <div className="persistent-session-weekly-usage-review-controls">
      <DashboardIconCap appearance="bare" size="small" label="주간 사용량" aria-pressed={enabled} onClick={() => setEnabled(value => !value)}>
        <Gauge className="size-4" strokeWidth={1.4} absoluteStrokeWidth aria-hidden="true" />
      </DashboardIconCap>
      <span aria-live="polite">{stateLabels[sampleState]}</span>
      <DashboardIconCap appearance="bare" size="small" label={`주간 사용량 샘플 상태 변경: ${stateLabels[sampleState]}`} onClick={changeState}>
        <RefreshCw className="size-4" strokeWidth={1.4} absoluteStrokeWidth aria-hidden="true" />
      </DashboardIconCap>
    </div>
    {enabled ? <PersistentSessionWeeklyUsage {...usage} onRetry={() => { setSampleState('normal'); setSelectedNodeId(null); }} onNextNode={nextNode} /> : null}
  </div>;
}
