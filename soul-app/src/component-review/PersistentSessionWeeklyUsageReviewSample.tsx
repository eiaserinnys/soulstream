import React, { useState } from 'react';
import { Text, View } from 'react-native';
import { LiquidGlassButton } from '../components/LiquidGlassButton';
import { PersistentSessionWeeklyUsage } from '../components/persistent/PersistentSessionWeeklyUsage';
import { PERSISTENT_SESSION_FRAME } from '../components/persistent/persistentSessionFrame';
import {
  maxWeeklyUsageGaugeCount,
  selectUsageSummaryNode,
  weeklyUsageGauges,
} from '../../../packages/soul-ui/src/lib/usage-summary';
import { useTokens } from '../theme';
import { persistentWeeklyUsageReviewSummary } from './persistent-fullscreen-fixtures';

type SampleState = 'three' | 'two' | 'empty' | 'loading' | 'error';
const sampleStates: SampleState[] = ['three', 'two', 'empty', 'loading', 'error'];
const stateLabels: Record<SampleState, string> = {
  three: '3개 게이지',
  two: '2개 게이지',
  empty: '주간 한도 없음',
  loading: '불러오는 중',
  error: '조회 실패',
};
const evaluatedAtMs = Date.now();

export function PersistentSessionWeeklyUsageReviewSample() {
  const t = useTokens();
  const [state, setState] = useState<SampleState>('three');
  const available = state === 'three' || state === 'two' || state === 'empty';
  const summary = available ? persistentWeeklyUsageReviewSummary : null;
  const preferredNodeId = state === 'two' ? 'node-b' : state === 'empty' ? 'node-c' : 'node-a';
  const node = selectUsageSummaryNode(summary, preferredNodeId, null);
  const gauges = weeklyUsageGauges(node);
  const landscapeWidth = PERSISTENT_SESSION_FRAME.landscape.tasks - 2 * t.uiSpacing.sm;
  const portraitWidth = PERSISTENT_SESSION_FRAME.portrait.tasks - 2 * t.uiSpacing.sm;
  const nextState = () => setState(current => sampleStates[(sampleStates.indexOf(current) + 1) % sampleStates.length]!);

  return <View testID="weekly-usage-review-sample" style={{ flex: 1, padding: t.foundation.pageInset,
    justifyContent: 'flex-end', backgroundColor: t.persistentSession.paper }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm, marginBottom: t.spacing.md }}>
      <Text style={{ flex: 1, ...t.foundation.typography.meta, color: t.colors.textMuted }}>{stateLabels[state]}</Text>
      <LiquidGlassButton size="compact" variant="plain" accessibilityLabel={`주간 사용량 샘플 상태 변경: ${stateLabels[state]}`}
        onPress={nextState} testID="weekly-usage-review-next-state">
        <Text style={{ ...t.foundation.typography.meta, color: t.colors.textPrimary }}>다음 상태</Text>
      </LiquidGlassButton>
    </View>
    <View style={{ flexDirection: 'row', alignItems: 'flex-end', alignSelf: 'flex-end', gap: t.spacing.xl }}>
      <View testID="weekly-usage-review-landscape" style={{ width: landscapeWidth }}>
        <PersistentSessionWeeklyUsage node={node} gauges={gauges}
          maxGaugeCount={maxWeeklyUsageGaugeCount(summary)} loading={state === 'loading'}
          loadState={state === 'error' ? 'connectionError' : available ? 'ready' : 'idle'}
          evaluatedAtMs={evaluatedAtMs} onRetry={() => setState('three')} onNextNode={nextState} />
      </View>
      <View testID="weekly-usage-review-portrait" style={{ width: portraitWidth }}>
        <PersistentSessionWeeklyUsage node={node} gauges={gauges}
          maxGaugeCount={maxWeeklyUsageGaugeCount(summary)} loading={state === 'loading'}
          loadState={state === 'error' ? 'connectionError' : available ? 'ready' : 'idle'}
          evaluatedAtMs={evaluatedAtMs} onRetry={() => setState('three')} onNextNode={nextState} />
      </View>
    </View>
  </View>;
}
