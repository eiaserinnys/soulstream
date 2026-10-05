import React, { useCallback, useMemo, useState } from 'react';
import { StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import type { CardNow, CardNowHistoryEntry } from '../../api/cardTypes';
import { createPlannerVisualRoles, useTokens, type DesignTokens } from '../../theme';
import { AppGlassCard } from '../AppGlassCard';
import { GlassButton } from '../GlassSurface';
import { CompactTouchTarget } from '../CompactTouchTarget';
import { withAlphaColor } from '../StatusPulseDecoration';

type Entry = { text: string; turn: CardNow['turn']; ask: string | null; at: string };

export function CardNowPanel({
  now,
  history,
  allConfirmed = false,
  surfaceRole = 'panel',
}: {
  now: CardNow;
  history: CardNowHistoryEntry[];
  allConfirmed?: boolean;
  surfaceRole?: 'panel' | 'glassCard';
}) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);
  const entries = useMemo<Entry[]>(() => [
    ...history.slice(0, -1).map((entry) => ({ ...entry })),
    { text: now.text, turn: now.turn, ask: now.ask, at: now.updatedAt },
  ], [history, now.ask, now.text, now.turn, now.updatedAt]);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [pinnedHeight, setPinnedHeight] = useState<number | null>(null);
  const [measuredWidth, setMeasuredWidth] = useState<number | null>(null);
  const currentHeight = React.useRef<number | null>(null);
  const index = selectedIndex === null ? entries.length - 1 : Math.min(selectedIndex, entries.length - 1);
  const entry = entries[index];
  const isLatest = index === entries.length - 1;
  const turnStyle = entry.turn === 'user' ? styles.userTurn : entry.turn === 'outside' ? styles.outsideTurn : styles.agentTurn;
  const turnLabelColor = entry.turn === 'user' ? t.colors.warningText : entry.turn === 'outside' ? t.colors.textMuted : t.colors.statusRunning;

  const onLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    currentHeight.current = height;
    if (measuredWidth !== null && width !== measuredWidth) {
      setSelectedIndex(null);
      setPinnedHeight(null);
    }
    setMeasuredWidth(width);
  }, [measuredWidth]);

  const showHistory = history.length > 1;
  const moveTo = (nextIndex: number) => {
    if (nextIndex === entries.length - 1) {
      setSelectedIndex(null);
      setPinnedHeight(null);
      return;
    }
    if (selectedIndex === null) setPinnedHeight(currentHeight.current);
    setSelectedIndex(nextIndex);
  };
  const completePrompt = allConfirmed && isLatest;
  const bandText = completePrompt
    ? '모두 확인했습니다. 완료로 옮길까요?'
    : isLatest
      ? entry.ask || ''
      : '아래 확인 항목은 지금 상태입니다.';

  return (
    <View testID="card-now-panel-frame" style={pinnedHeight === null ? undefined : { height: pinnedHeight }}>
      <AppGlassCard
        testID="card-now-panel"
        onLayout={onLayout}
        role={surfaceRole}
        style={[styles.panel, !isLatest && styles.pastPanel, pinnedHeight === null ? undefined : { height: pinnedHeight }]}
      >
        <View style={styles.headerRow}>
          <View style={styles.headerLabels}>
            <Text style={styles.eyebrow} numberOfLines={1}>
              {isLatest ? '지금' : '지난 상황'}{showHistory ? ` ${index + 1}/${entries.length}` : ''}
            </Text>
            <Text style={styles.updatedAt} numberOfLines={1}>{formatUpdatedAt(entry.at)}</Text>
          </View>
        </View>
        <Text testID="card-now-text" numberOfLines={isLatest ? undefined : 3} style={styles.nowText}>{entry.text}</Text>
        <View style={[styles.turnBand, turnStyle, !isLatest && styles.pastBand, completePrompt && styles.completeBand]}>
          {isLatest ? (
            <>
              {!completePrompt ? <Text style={[styles.turnLabel, { color: turnLabelColor }]}>{turnLabel(entry.turn)}</Text> : null}
              <Text numberOfLines={3} style={[styles.turnText, completePrompt && styles.completeText]}>{bandText}</Text>
            </>
          ) : (
            <>
              <Text style={styles.turnText} numberOfLines={2}>{bandText}</Text>
              <CompactTouchTarget
                testID="card-now-latest"
                accessibilityLabel="최신 상황"
                frameStyle={styles.latestFrame}
                surfaceStyle={styles.latestSurface}
                onPress={() => { setSelectedIndex(null); setPinnedHeight(null); }}
              >
                <Text style={styles.latestText}>최신으로</Text>
              </CompactTouchTarget>
            </>
          )}
        </View>
        {showHistory ? (
          <View pointerEvents="box-none" style={styles.arrows}>
            <GlassButton
              iconOnly size="compact" borderRadius={t.foundation.radius.round}
              accessibilityLabel="이전 상황" accessibilityState={{ disabled: index === 0 }}
              disabled={index === 0} frameStyle={styles.arrowFrameLeft}
              onPress={() => moveTo(Math.max(0, index - 1))}
            >
              <Text style={styles.arrowGlyph}>‹</Text>
            </GlassButton>
            <GlassButton
              iconOnly size="compact" borderRadius={t.foundation.radius.round}
              accessibilityLabel={isLatest ? '최신 상황' : '다음 상황'}
              accessibilityState={{ disabled: isLatest }} disabled={isLatest}
              frameStyle={styles.arrowFrameRight}
              onPress={() => moveTo(Math.min(entries.length - 1, index + 1))}
            >
              <Text style={styles.arrowGlyph}>›</Text>
            </GlassButton>
          </View>
        ) : null}
      </AppGlassCard>
    </View>
  );
}

function turnLabel(turn: CardNow['turn']): string {
  switch (turn) {
    case 'user': return '내 차례';
    case 'outside': return '바깥 대기';
    default: return '에이전트 차례';
  }
}

function formatUpdatedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false })}에 고침`;
}

function makeStyles(t: DesignTokens) {
  const planner = createPlannerVisualRoles(t);
  return StyleSheet.create({
    panel: { paddingVertical: t.uiSpacing.md, paddingHorizontal: t.uiSpacing.lg, borderRadius: t.foundation.radius.field, gap: t.uiSpacing.sm },
    pastPanel: { borderStyle: 'dashed' },
    headerRow: { height: planner.typography.meta.lineHeight, justifyContent: 'center', paddingRight: t.foundation.iconFrame.compact * 2 },
    headerLabels: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: t.uiSpacing.sm },
    eyebrow: { ...planner.typography.meta, color: t.colors.textSecondary, flexShrink: 0 },
    updatedAt: { ...planner.typography.meta, color: t.colors.textMuted, flexShrink: 1, textAlign: 'right' },
    arrows: { position: 'absolute', top: t.uiSpacing.md, left: t.uiSpacing.lg, right: t.uiSpacing.lg,
      height: planner.typography.meta.lineHeight, pointerEvents: 'box-none' },
    arrowFrameLeft: { position: 'absolute', right: t.foundation.iconFrame.compact - t.uiSpacing.sm,
      top: -(t.hitTarget.min - planner.typography.meta.lineHeight) / 2 },
    arrowFrameRight: { position: 'absolute', right: -t.uiSpacing.sm,
      top: -(t.hitTarget.min - planner.typography.meta.lineHeight) / 2 },
    arrowGlyph: { ...planner.typography.cardTitle, color: t.colors.textSecondary },
    nowText: { ...planner.typography.body, color: t.colors.textPrimary },
    turnBand: { minHeight: t.hitTarget.min, flexDirection: 'row', alignItems: 'center', gap: t.uiSpacing.sm, paddingHorizontal: t.uiSpacing.sm, paddingVertical: t.uiSpacing.xs, borderRadius: t.foundation.radius.field },
    agentTurn: { backgroundColor: withAlphaColor(t.colors.statusRunning, 0.12) },
    userTurn: { backgroundColor: withAlphaColor(t.colors.warning, 0.12) },
    outsideTurn: { backgroundColor: withAlphaColor(t.colors.statusIdle, 0.12) },
    pastBand: { backgroundColor: 'transparent', justifyContent: 'space-between', paddingHorizontal: 0 },
    completeBand: { backgroundColor: withAlphaColor(t.colors.statusCompleted, 0.12) },
    turnLabel: { ...planner.typography.meta, fontWeight: '700' },
    turnText: { ...planner.typography.body, color: t.colors.textPrimary, flex: 1, flexShrink: 1 },
    completeText: { color: t.colors.statusCompleted, fontWeight: '700' },
    latestFrame: { flexShrink: 0 },
    latestSurface: { minHeight: t.hitTarget.min, paddingHorizontal: t.uiSpacing.xs, justifyContent: 'center' },
    latestText: { ...planner.typography.meta, color: t.colors.accent },
  });
}
