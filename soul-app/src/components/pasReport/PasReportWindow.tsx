// 카드 #1871: PAS 결재형 보고 창(C안 「시간순 통합 사건 스레드」). 폰 화면과 태블릿 겹침이 같은 부품을 쓴다.
// 820pt 이상은 왼쪽 고정 레일, 그 아래는 머리줄 「안건 목록」 단추로 여는 서랍이 같은 세로 행을 그린다.
import React, { forwardRef, useImperativeHandle, useMemo, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useTokens, type DesignTokens } from '../../theme';
import { AppKeyboardAvoidingView } from '../AppKeyboardAvoidingView';
import { LiquidGlassButton } from '../LiquidGlassButton';
import { PasReportDecideBox, useDecideUi } from './PasReportDecideBox';
import { PasReportRail } from './PasReportRail';
import { PasReportThread } from './PasReportThread';
import { usePasReportWindow, type PasReportWindowInput } from './usePasReportWindow';
import { useScrollFollow } from './useScrollFollow';

/** 화면 폭(pt)이 이 이상이면 레일이 왼쪽에 고정된다. 그 아래는 서랍이다(기준본). 웹판의 820 전환점과 같다. */
export const PAS_REPORT_RAIL_MIN_WIDTH = 820;

export interface PasReportWindowHandle {
  /** 열린 것 하나(서랍, 답변 미루기 펼침, 입력창)를 닫았으면 true. 닫을 것이 없으면 false라 부른 쪽이 창을 닫는다. */
  back(): boolean;
}
export interface PasReportWindowProps extends PasReportWindowInput {
  onClose(): void;
  /** 카드 패널 열기. 폰은 기존 CardDetail 화면으로 가고, 태블릿은 PAS 화면이 카드를 여는 지금 길을 따른다. */
  onOpenCard(cardId: string): void;
}

export const PasReportWindow = forwardRef<PasReportWindowHandle, PasReportWindowProps>(function PasReportWindow(props, ref) {
  const { onClose, onOpenCard } = props;
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);
  const controller = usePasReportWindow(props);
  const { width } = useWindowDimensions();
  const [paneWidth, setPaneWidth] = useState(0);
  const wide = width >= PAS_REPORT_RAIL_MIN_WIDTH;
  const [drawerRequested, setDrawerRequested] = useState(false);
  const drawerOpen = drawerRequested && !wide;
  const ui = useDecideUi(controller.activeCardId);
  const follow = useScrollFollow(controller.activeCardId);
  const { active } = controller;

  useImperativeHandle(ref, () => ({
    back() {
      if (drawerOpen) { setDrawerRequested(false); return true; }
      if (ui.snoozeOpen) { ui.setSnoozeOpen(false); return true; }
      if (ui.mode !== 'closed') { controller.setTargetItem(null); ui.setMode('closed'); return true; }
      return false;
    },
  }), [controller, drawerOpen, ui]);

  const select = (cardId: string) => { controller.select(cardId); setDrawerRequested(false); };
  const rail = <PasReportRail controller={controller} onSelect={select} />;
  const iconButton = (testID: string, label: string, icon: React.ComponentProps<typeof Ionicons>['name'], onPress: () => void, disabled = false, expanded?: boolean) =>
    <LiquidGlassButton testID={testID} iconOnly variant="plain" size="compact" disabled={disabled} accessibilityLabel={label}
      accessibilityState={expanded === undefined ? undefined : { expanded }} onPress={onPress}>
      <Ionicons name={icon} size={t.iconSize.navigation} color={disabled ? t.colors.textPlaceholder : t.colors.textPrimary} />
    </LiquidGlassButton>;
  return <AppKeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.root}>
    <View testID="pas-report-window" accessibilityLabel="보고 창" style={styles.root}>
      <View testID="pas-report-header" style={styles.header}>
        <View style={styles.heading}>
          {active?.number != null ? <Text style={styles.number}>#{active.number}</Text> : null}
          <Text testID="pas-report-title" accessibilityRole="header" numberOfLines={1} style={styles.title}>{active?.title || '보고 창'}</Text>
        </View>
        <View style={styles.tools}>
          {wide ? null : iconButton('pas-report-open-rail', '안건 목록', 'list-outline', () => setDrawerRequested(value => !value), false, drawerOpen)}
          {iconButton('pas-report-open-card', '카드 패널 열기', 'albums-outline', () => { if (active) onOpenCard(active.cardId); }, !active)}
          {iconButton('pas-report-close', '보고 창 닫기', 'close', onClose)}
        </View>
      </View>
      <View style={styles.body}>
        {wide ? <View testID="pas-report-rail-fixed" style={styles.railFixed}>{rail}</View> : null}
        <View style={styles.pane} onLayout={event => setPaneWidth(event.nativeEvent.layout.width)}>
          <PasReportThread controller={controller} follow={follow} paneWidth={paneWidth} />
          <PasReportDecideBox controller={controller} ui={ui} />
        </View>
        {drawerOpen ? <>
          <Pressable testID="pas-report-drawer-scrim" accessibilityRole="button" accessibilityLabel="안건 목록 닫기"
            onPress={() => setDrawerRequested(false)} style={styles.scrim} />
          <View testID="pas-report-drawer" style={styles.drawer}>{rail}</View>
        </> : null}
      </View>
    </View>
  </AppKeyboardAvoidingView>;
});

function makeStyles(t: DesignTokens) {
  const type = t.foundation.typography;
  const railWidth = t.hitTarget.min * 6 + t.uiSpacing.md;
  return StyleSheet.create({
    root: { flex: 1, minHeight: 0, backgroundColor: t.persistentSession.paper },
    header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', columnGap: t.uiSpacing.sm,
      paddingLeft: t.uiSpacing.lg, paddingRight: t.uiSpacing.sm, paddingVertical: t.uiSpacing.sm,
      borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: t.persistentSession.line },
    heading: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', columnGap: t.uiSpacing.sm },
    number: { ...type.meta, color: t.colors.accent, fontVariant: ['tabular-nums'] },
    title: { ...type.cardTitle, flexShrink: 1, color: t.colors.textPrimary },
    tools: { flexDirection: 'row', alignItems: 'center', columnGap: t.uiSpacing.xs },
    body: { flex: 1, minHeight: 0, flexDirection: 'row' },
    railFixed: { width: railWidth, borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: t.persistentSession.line },
    pane: { flex: 1, minWidth: 0, minHeight: 0 },
    scrim: { ...StyleSheet.absoluteFill, minWidth: t.hitTarget.min, minHeight: t.hitTarget.min, backgroundColor: t.colors.background, opacity: 0.5 },
    drawer: { position: 'absolute', left: 0, top: 0, bottom: 0, width: railWidth, maxWidth: '85%', backgroundColor: t.persistentSession.paper,
      borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: t.persistentSession.line },
  });
}
