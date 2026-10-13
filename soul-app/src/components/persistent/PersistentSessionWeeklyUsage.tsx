import React from 'react';
import { Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import {
  formatUsageResetCountdown,
  formatUsageUpdatedLabel,
  formatWeeklyRemainingPercent,
} from '../../../../packages/soul-ui/src/lib/usage-summary';
import { CompactTouchTarget } from '../CompactTouchTarget';
import { LiquidGlassButton } from '../LiquidGlassButton';
import { useTokens } from '../../theme';
import { DESIGN_SPACING } from '../../theme/tokens';
import type { UseUsageSummaryResult } from '../../hooks/useUsageSummary';

type Props = Pick<UseUsageSummaryResult,
  'node' | 'gauges' | 'maxGaugeCount' | 'loading' | 'loadState' | 'evaluatedAtMs'> & {
  onRetry: () => void;
  onNextNode: () => void;
};

function emptyMessage({ loading, loadState, node, gauges }: Pick<Props, 'loading' | 'loadState' | 'node' | 'gauges'>): string | null {
  if (gauges.length) return null;
  if (loading) return '불러오는 중';
  if (loadState === 'connectionError') return '조회 실패';
  if (node) return '주간 한도 없음';
  return '수집 대기';
}

export function PersistentSessionWeeklyUsage({
  node,
  gauges,
  maxGaugeCount,
  loading,
  loadState,
  evaluatedAtMs,
  onRetry,
  onNextNode,
}: Props) {
  const t = useTokens();
  const message = emptyMessage({ loading, loadState, node, gauges });
  const stale = loadState === 'connectionError' && gauges.length > 0;
  const updatedLabel = stale && node ? formatUsageUpdatedLabel(node.fetchedAt, true) : null;
  const accessibilityLabel = stale && updatedLabel
    ? `주간 남은 사용량, 갱신 지연, ${updatedLabel}`
    : '주간 남은 사용량';
  const slotCount = Math.max(3, maxGaugeCount, gauges.length);
  const visibleGaugeSlots = gauges.length || 1;
  const placeholderCount = Math.max(0, slotCount - visibleGaugeSlots);
  const meta = t.foundation.typography.meta;
  const trackHeight = DESIGN_SPACING.xs;
  const slotHeight = meta.lineHeight + t.spacing.xxs + trackHeight;
  const nodeVisualHeight = Math.max(meta.lineHeight, t.iconSize.compact);

  const renderGauge = (gauge: Props['gauges'][number], index: number) => {
    const percent = formatWeeklyRemainingPercent(gauge.remainingPercent);
    const warning = gauge.remainingPercent < 20;
    const compactCountdown = formatUsageResetCountdown(gauge.resetAt, evaluatedAtMs, true);
    const fullCountdown = formatUsageResetCountdown(gauge.resetAt, evaluatedAtMs, false);
    return <View key={gauge.id} testID={`persistent-session-weekly-usage-slot-${index}`}
      style={{ height: slotHeight, gap: t.spacing.xxs }}>
      <View testID={`persistent-session-weekly-usage-row-${gauge.id}`}
        style={{ minWidth: 0, height: meta.lineHeight, flexDirection: 'row', alignItems: 'baseline', gap: t.spacing.xs }}>
        <Text numberOfLines={1} style={{ flex: 1, ...meta, color: t.colors.textPrimary }}>{gauge.label}</Text>
        {compactCountdown ? <Text numberOfLines={1} accessibilityLabel={fullCountdown ? `초기화까지 ${fullCountdown}` : undefined}
          style={{ ...meta, color: t.colors.textMuted }}>{compactCountdown}</Text> : null}
        <Text style={{ ...meta, color: warning ? t.colors.warningText : t.colors.textPrimary,
          fontWeight: '600', fontVariant: ['tabular-nums'] }}>{percent}</Text>
      </View>
      <View testID={`persistent-session-weekly-usage-track-${gauge.id}`} accessibilityRole="progressbar"
        accessibilityLabel={`${gauge.label} 주간 잔량`}
        accessibilityValue={{ min: 0, max: 100, now: gauge.remainingPercent, text: percent }}
        style={{ height: trackHeight, borderRadius: t.radius.sm, backgroundColor: t.persistentSession.line, overflow: 'hidden' }}>
        <View style={{ height: '100%', width: `${gauge.remainingPercent}%`, backgroundColor: warning ? t.colors.warning : t.colors.accent }} />
      </View>
    </View>;
  };

  const renderStatus = () => <View testID="persistent-session-weekly-usage-status-slot"
    style={{ height: slotHeight, gap: t.spacing.xxs }}>
    <View style={{ height: meta.lineHeight, flexDirection: 'row', alignItems: 'center', position: 'relative' }}>
      <Text accessibilityRole="text" testID="persistent-session-weekly-usage-status" numberOfLines={1}
        style={{ flex: 1, paddingRight: loadState === 'connectionError' ? t.hitTarget.min : 0, ...meta, color: t.colors.textMuted }}>
        {message}
      </Text>
      {loadState === 'connectionError' ? <LiquidGlassButton iconOnly variant="plain" size="compact"
        accessibilityLabel="주간 사용량 다시 시도" accessibilityState={{ disabled: loading }} disabled={loading}
        onPress={onRetry} testID="persistent-session-weekly-usage-retry"
        frameStyle={{ position: 'absolute', top: (meta.lineHeight - t.hitTarget.min) / 2,
          right: -(t.hitTarget.min - t.iconSize.compact) / 2 }}>
        <Ionicons name="refresh-outline" size={t.iconSize.compact} color={t.colors.textMuted} />
      </LiquidGlassButton> : null}
    </View>
    <View testID="persistent-session-weekly-usage-status-track" accessibilityElementsHidden
      style={{ height: trackHeight, borderRadius: t.radius.sm }} />
  </View>;

  return <View testID="persistent-session-weekly-usage" accessibilityRole="summary" accessibilityLabel={accessibilityLabel}
    style={{ minWidth: 0, gap: t.spacing.md }}>
    {Array.from({ length: placeholderCount }, (_, index) => <View key={`placeholder-${index}`}
      testID={`persistent-session-weekly-usage-slot-${index}`} accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants" pointerEvents="none"
      style={{ height: slotHeight, gap: t.spacing.xxs }}>
      <View style={{ height: meta.lineHeight }} />
      <View style={{ height: trackHeight }} />
    </View>)}
    {gauges.length
      ? gauges.map((gauge, index) => renderGauge(gauge, placeholderCount + index))
      : renderStatus()}
    {node ? <View testID="persistent-session-weekly-usage-node-row" style={{ height: nodeVisualHeight, position: 'relative' }}>
      <CompactTouchTarget testID="persistent-session-weekly-usage-node" surfaceTestID="persistent-session-weekly-usage-node-surface"
        accessibilityRole="button" accessibilityLabel={`노드 바꾸기, 현재 ${node.nodeId}`} onPress={onNextNode}
        frameStyle={{ position: 'absolute', left: 0, width: '100%', height: t.hitTarget.min,
          top: (nodeVisualHeight - t.hitTarget.min) / 2 }}
        surfaceStyle={{ width: '100%', height: nodeVisualHeight }}>
        <View style={{ width: '100%', height: nodeVisualHeight, flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm }}>
          <Text numberOfLines={1} ellipsizeMode="tail" style={{ flex: 1, ...meta, color: t.colors.textMuted }}>{node.nodeId}</Text>
          <Ionicons testID="persistent-session-weekly-usage-chevron" name="chevron-forward" size={t.iconSize.compact}
            color={t.colors.textMuted} style={{ marginRight: -DESIGN_SPACING.xs }} />
        </View>
      </CompactTouchTarget>
    </View> : <View testID="persistent-session-weekly-usage-node-row" accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants" style={{ height: nodeVisualHeight }} />}
  </View>;
}
