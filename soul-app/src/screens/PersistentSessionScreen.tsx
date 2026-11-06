import { useOptionalLayoutContinuity } from '../navigation/LayoutContinuityContext';
import React, { useMemo, useState } from 'react';
import { Alert, BackHandler, PanResponder, Platform, ScrollView, StyleSheet, Text, View, useWindowDimensions, type LayoutRectangle } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { calculatePersistentSessionLayout, type PersistentSessionRect } from '../../../packages/soul-ui/src/lib/persistent-session-layout';
import { nextUsageSummaryNodeId } from '../../../packages/soul-ui/src/lib/usage-summary';
import { createApiClient } from '../api/client';
import { ChatBody } from '../components/chat/ChatBody';
import { ChatUiControllerProvider, useChatUiActions } from '../components/chat-ui/ChatUiControllerProvider';
import type { ChatInputComposerHandle } from '../components/chat/ChatInputComposer';
import { usePersistentReport } from '../components/persistent/usePersistentReport';
import { usePersistentReportSend } from '../components/persistent/usePersistentReportSend';
import { PersistentReportPager } from '../components/persistent/PersistentReportPager';
import { usePersistentCardCompletion } from '../components/persistent/usePersistentCardCompletion';
import { minimumReportBubbleHeight } from '../components/persistent/persistentReportStyles';
import { LiquidGlassButton } from '../components/LiquidGlassButton';
import { PersistentSessionCardOverlay } from '../components/persistent/PersistentSessionCardOverlay';
import { PersistentReportCardExpansion } from '../components/persistent/PersistentReportCardExpansion';
import { PersistentSessionTaskList } from '../components/persistent/PersistentSessionTaskList';
import { SwayCharacter } from '../components/persistent/SwayCharacter';
import { PERSISTENT_SESSION_FRAME as FRAME } from '../components/persistent/persistentSessionFrame';
import { PersistentSessionPasSettingsModal } from '../components/settings/PersistentSessionPasSettingsModal';
import { persistentChatDisplaySettings, savePersistentSessionSettings } from '../components/settings/persistentSessionSettingsActions';
import { useDisplayPreferenceActions } from '../components/settings/useDisplayPreferenceActions';
import { GlassButton } from '../components/GlassSurface';
import { CardStatusChip } from '../components/planner/CardRow';
import { PersistentSessionWeeklyUsage } from '../components/persistent/PersistentSessionWeeklyUsage';
import { useUsageSummary } from '../hooks/useUsageSummary';
import { useOpenContentLink } from '../hooks/useOpenContentLink';
import { decodeAuthJwt } from '../auth/jwt-payload';
import { usePersistentSessionHost, usePersistentSessionScene } from '../navigation/PersistentSessionContext';
import { usePhoneRailMode } from '../navigation/tabContract';
import { DUO_RAIL_CENTER_FROM_END, DUO_RAIL_END_INSET, DUO_SIDE_BAND_WIDTH, DUO_TOP_BAND_RAIL_TOP, DUO_TOP_BAND_STATUS_CENTER_Y, DUO_TOP_BAND_STATUS_RESERVE, getDuoRailTopOffset, splitDuoRailBackAction, useDuoSideBand, useDuoTopBand } from '../navigation/duoSideBand';
import { AppKeyboardAvoidingView } from '../components/AppKeyboardAvoidingView';
import { RAIL_CAPSULE_WIDTH, railCapsuleLength, RailCapsule, RailCapsuleItem } from '../components/navigation/RailCapsule';
import { useActiveDuoRailOverrideEntry, type PhoneRailAction } from '../navigation/phoneRailActions';
import { duoRailLayout } from '../navigation/duoRailLayout';
import { usePasContextMenu } from '../components/persistent/usePasContextMenu';
import { useAuthStore } from '../store/authStore';
import { useChatStore } from '../store/chatStore';
import { useSessionStore } from '../store/sessionStore';
import { useSettingsStore } from '../store/settingsStore';
import { createSessionVisualRoles, useDeviceType, useTokens } from '../theme';
import type { PersistentReportEntry } from '../api/types';
import { persistentReportStatusCard } from '../lib/persistent-report-card';
import { resolvePersistentConversationLeft } from '../lib/persistent-session-column';

export interface PersistentSessionScreenProps {
  active?: boolean;
  chatActive?: boolean;
  onOpenPhoneCard?(cardId: string): void;
  onHome(): void;
}

export function PersistentSessionScreen(props: PersistentSessionScreenProps) {
  const sessionId = usePersistentSessionScene(state => state.session?.session_id) ?? '';
  const inputComposerRef = React.useRef<ChatInputComposerHandle>(null);
  const append = React.useCallback((id: string, text: string) => inputComposerRef.current?.appendGeneratedText(id, text)
    ?? { ok: false as const, reason: 'not_ready' as const }, []);
  return <ChatUiControllerProvider sessionId={sessionId} appendGeneratedText={append}>
    <PersistentSessionContents {...props} inputComposerRef={inputComposerRef} />
  </ChatUiControllerProvider>;
}
function PersistentSessionContents({ active = true, chatActive = active, onOpenPhoneCard, onHome, inputComposerRef }: PersistentSessionScreenProps & { inputComposerRef: React.RefObject<ChatInputComposerHandle | null> }) {
  const t = useTokens();
  const device = useDeviceType();
  const phone = device === 'phone';
  const railMode = usePhoneRailMode();
  const duoSideBand = useDuoSideBand();
  const duoTopBand = useDuoTopBand() && !phone;
  const { fontScale, width: windowWidth, height: windowHeight } = useWindowDimensions();
  const railEntry = useActiveDuoRailOverrideEntry();
  const railOverride = railEntry?.mode === 'replace' ? railEntry.actions : null;
  const { backAction: railBack, mainActions: railMain } = splitDuoRailBackAction(railOverride);
  const insets = useSafeAreaInsets();
  const bottomSafeAreaInset = phone || duoSideBand ? 0 : insets.bottom;
  const host = usePersistentSessionHost();
  const session = usePersistentSessionScene(state => state.session);
  const hasMultiplePas = usePersistentSessionScene(state => state.sessions.length > 1);
  const storedScene = usePersistentSessionScene(state => state.scene);
  const reportsListMode = duoSideBand || duoTopBand;
  const scene = storedScene === 'reports' && !reportsListMode ? 'conversation' : storedScene;
  const selectedCardId = usePersistentSessionScene(state => state.selectedCardId);
  const phoneCardsScene = phone && scene === 'cards';
  const reportsScene = reportsListMode && scene === 'reports';
  const hidePhoneConversation = (phoneCardsScene && !selectedCardId) || (phone && reportsScene);
  const serverUrl = useSettingsStore(state => state.serverUrl);
  const jwt = useAuthStore(state => state.jwt);
  const email = decodeAuthJwt(jwt)?.email;
  const showWeeklyUsage = useSettingsStore(state => state.getPersistentSessionDevicePreference(serverUrl, email).showWeeklyUsage ?? false);
  const usageConfiguredNodeId = useSettingsStore(state => state.getPersistentSessionDevicePreference(serverUrl, email).weeklyUsageNodeSelection?.configuredNodeId ?? null);
  const storedUsageNodeId = useSettingsStore(state => state.getPersistentSessionDevicePreference(serverUrl, email).weeklyUsageNodeSelection?.selectedNodeId ?? null);
  const selectedUsageNodeId = usageConfiguredNodeId === session?.node_id ? storedUsageNodeId : null;
  const api = useMemo(() => serverUrl ? createApiClient(serverUrl) : null, [serverUrl]);
  const { setNotice } = useChatUiActions();
  const pending = useChatStore(state => session ? state.pendingOptimisticBySession[session.session_id] : undefined);
  const completion = usePersistentCardCompletion(api);
  const report = usePersistentReport(session?.session_id, true, api, session?.persistent_report, pending, completion.filterEntries);
  const pendingReportKey = usePersistentSessionScene(state => state.pendingReportKey);
  const [revealReportKey, setRevealReportKey] = useState<string | null>(null);
  React.useEffect(() => {
    if (!pendingReportKey) return;
    const index = report.entries.findIndex(entry => entry.key === pendingReportKey);
    if (index !== -1) {
      report.select(index);
      if (reportsListMode) {
        setRevealReportKey(pendingReportKey);
        if (host.store.getState().scene !== 'reports') host.store.getState().toggleReports();
      }
    }
    host.store.getState().clearReportFocus();
  }, [pendingReportKey, report.entries, reportsListMode, host.store]);
  const status = useSessionStore(state => session ? state.sessions[session.session_id]?.status : undefined);
  const reportSend = usePersistentReportSend(session?.session_id ?? '', api, report.entries, report.server, status, setNotice);
  const reportCount = reportSend.entries.length;
  const hasReports = reportCount > 0 || !!completion.recent;
  React.useEffect(() => {
    host.store.getState().setReportAvailability(reportCount, hasReports);
    if (!hasReports && host.store.getState().scene === 'reports') host.store.getState().toggleReports();
  }, [host.store, session, reportCount, hasReports]);
  React.useEffect(() => {
    if (!reportsListMode && host.store.getState().scene === 'reports') host.store.getState().toggleReports();
  }, [reportsListMode, host.store, storedScene]);
  const [reportPressed, setReportPressed] = useState(false);
  const [reportReady, setReportReady] = useState(false);
  const reportTouch = React.useRef(false);
  const onReportDeckTouch = React.useCallback((active: boolean) => { reportTouch.current = active; }, []);
  const display = useChatStore(state => session?.session_id
    ? state.persistentDisplaySettingsBySession[session.session_id]?.settings ?? null
    : null);
  const { handleAppearanceChange } = useDisplayPreferenceActions();
  const continuity = useOptionalLayoutContinuity();
  const pasKey = JSON.stringify(['pas', session?.session_id]);
  const savedPas = continuity?.getViewState<{ settingsOpen?: boolean; expandedKey?: string | null }>(pasKey);
  const settingsOpen = usePersistentSessionScene(state => state.settingsOpen);
  const setSettingsOpen = usePersistentSessionScene(state => state.setSettingsOpen);
  const pasMenu = usePasContextMenu();
  React.useLayoutEffect(() => {
    if (savedPas?.settingsOpen !== undefined) setSettingsOpen(savedPas.settingsOpen);
  }, []);
  const [reportExpansion, setReportExpansion] = useState<{ sessionId?: string; key: string | null }>({ sessionId: session?.session_id, key: savedPas?.expandedKey ?? null });
  const expandedReportKey = reportExpansion.sessionId === session?.session_id ? reportExpansion.key : null;
  React.useEffect(() => {
    continuity?.setViewState(pasKey, { ...continuity.getViewState<object>(pasKey), settingsOpen,
      expandedKey: phone ? null : expandedReportKey });
  }, [continuity, pasKey, settingsOpen, phone, expandedReportKey]);
  const [reportSeatHeight, setReportSeatHeight] = useState(0);
  const openContentLink = useOpenContentLink();
  const openCard = React.useCallback((cardId: string) => {
    if (phone && onOpenPhoneCard) onOpenPhoneCard(cardId);
    else host.store.getState().selectCard(cardId);
  }, [host.store, onOpenPhoneCard, phone]);
  const openReportCardDirectly = React.useCallback(async (entry: PersistentReportEntry) => {
    let cardId = entry.card_id ?? null;
    if (!cardId && entry.card_numbers.length === 1 && api) {
      const cardNumber = entry.card_numbers[0];
      try {
        const { cards } = await api.listCards(undefined, { includeCompleted: true });
        cardId = cards.find(card => card.number === cardNumber)?.id ?? null;
      } catch {
        setNotice(`#${cardNumber} 카드를 불러오지 못했어.`);
        return;
      }
      if (!cardId) {
        setNotice(`#${cardNumber} 카드를 찾지 못했어.`);
        return;
      }
    }
    if (!cardId) return;
    if (onOpenPhoneCard) onOpenPhoneCard(cardId);
    else if (phone) void openContentLink(`/?card=${encodeURIComponent(cardId)}`);
    else host.store.getState().selectReportCard(cardId);
  }, [api, host.store, onOpenPhoneCard, openContentLink, phone, setNotice]);
  const [savingCharacter, setSavingCharacter] = useState(false);
  const appRef = React.useRef<View>(null);
  const mainRef = React.useRef<View>(null);
  const [app, setApp] = useState<PersistentSessionRect | null>(null);
  const [main, setMain] = useState<PersistentSessionRect | null>(null);
  const [composer, setComposer] = useState<{ anchor: LayoutRectangle; box: LayoutRectangle } | null>(null);
  const [keyboardOverlap, setKeyboardOverlap] = useState(0);
  const railBottom = Math.max(keyboardOverlap, insets.bottom, t.uiSpacing.xxl);
  const onKeyboardOverlapChange = React.useCallback((overlap: number) => {
    setKeyboardOverlap(current => current === overlap ? current : overlap);
  }, []);
  const [usageHeight, setUsageHeight] = useState(0);
  const compact = phone || (app?.height ?? Infinity) < FRAME.compactHeight;
  const baseHeaderHeight = compact ? FRAME.compactHeader : FRAME.header;
  const topBandInset = duoTopBand ? DUO_TOP_BAND_STATUS_CENTER_Y - baseHeaderHeight / 2 : 0;
  const headerHeight = baseHeaderHeight + topBandInset;
  const rightControlsHeight = duoSideBand ? 0 : duoTopBand ? RAIL_CAPSULE_WIDTH + t.uiSpacing.sm : t.hitTarget.min;
  const railTokens = { spacingXs: t.spacing.xs, uiSpacingXs: t.uiSpacing.xs, uiSpacingSm: t.uiSpacing.sm, hitTargetMin: t.hitTarget.min };
  const pasActions: PhoneRailAction[] = [
    ...(session?.node_id ? [{ id: 'usage', kind: 'status' as const, label: '주간 사용량',
      menuLabel: showWeeklyUsage ? '주간 사용량 숨기기' : '주간 사용량 보기', icon: 'speedometer-outline' as const, selected: showWeeklyUsage,
      onPress: () => useSettingsStore.getState().setPersistentSessionShowWeeklyUsage(serverUrl, email, !showWeeklyUsage) }] : []),
    { id: 'tasks', kind: 'view', selected: scene === 'cards', label: scene === 'cards' ? 'PAS 대화로 돌아가기' : '카드 목록 보기', icon: 'list-outline',
      onPress: () => host.store.getState().toggleCards() },
    { id: 'reports', kind: 'view', label: !hasReports ? '지금의 보고 없음' : reportsScene ? 'PAS 대화로 돌아가기' : '지금의 보고',
      icon: 'chatbubble-ellipses-outline', selected: reportsScene, badgeCount: reportCount, disabled: !hasReports,
      onPress: () => host.store.getState().toggleReports() },
  ];
  const railMenu: PhoneRailAction | null = railOverride?.length
    ? railMain.find(item => item.kind === 'menu') ?? null
    : { id: 'menu', kind: 'menu', label: 'PAS 메뉴', icon: 'ellipsis-horizontal', onPress: pasMenu.show,
      menuItems: pasMenu.items, menuTitle: pasMenu.title };
  const railLayout = duoRailLayout({ exit: railBack?.disabled ? null : railBack ?? { id: 'home', kind: 'exit', label: '홈으로 돌아가기', icon: 'home-outline', onPress: onHome },
    screen: railOverride?.length ? railMain.filter(item => item.kind !== 'menu' && item.kind !== 'rare') : pasActions,
    nav: [], rare: railOverride?.length ? railMain.filter(item => item.kind === 'rare') : [], menu: railMenu,
    length: windowHeight, statusReserve: duoTopBand ? DUO_TOP_BAND_RAIL_TOP : getDuoRailTopOffset(windowWidth, windowHeight),
    endReserve: Math.max(insets.bottom, t.uiSpacing.xxl), keyboardOverlap, tokens: railTokens });
  const screenRailTop = windowHeight - railBottom - railCapsuleLength(railLayout.screen.length, railLayout.compact, railTokens);
  const railColumnBottom = Math.max(0, (app?.height ?? windowHeight) - screenRailTop + t.uiSpacing.sm);
  const rightColumnOffset = duoTopBand ? DUO_RAIL_CENTER_FROM_END - RAIL_CAPSULE_WIDTH / 2 - t.uiSpacing.sm : t.foundation.pageInset - t.uiSpacing.sm;
  const portrait = app ? app.height > app.width : false;
  const widths = portrait ? FRAME.portrait : FRAME.landscape;
  const hasWeeklyUsage = Boolean(session?.node_id && showWeeklyUsage);
  const usageInColumn = !!app && !phone && hasWeeklyUsage
    && (duoSideBand || (!(Platform as { isPad?: boolean }).isPad
      && (app.width + widths.conversation) / 2 > app.width - t.foundation.pageInset - (widths.tasks - 2 * t.uiSpacing.sm)));
  const rightColumnVisible = scene === 'cards' || usageInColumn;
  const columnWidth = phone ? Math.max(0, (app?.width ?? 0) - t.foundation.pageInset * 2)
    : duoSideBand && rightColumnVisible ? FRAME.portrait.conversation : widths.conversation;
  // 카드 장면에서는 우측 카드 패널(tasks)과 겹치지 않도록 대화 열을 왼쪽으로 밀되,
  // 화면 중앙보다 오른쪽으로는 가지 않는다. 넓은 화면에서는 중앙 배치가 유지된다.
  const columnLeft = app
    ? resolvePersistentConversationLeft({
      appWidth: app.width,
      columnWidth,
      tasksWidth: widths.tasks,
      phone,
      cardsScene: rightColumnVisible,
      pageInset: t.foundation.pageInset,
      gap: t.spacing.md,
      cardPanelRightOffset: rightColumnOffset,
    })
    : 0;
  const usageSummary = useUsageSummary({ enabled: active && !phone && hasWeeklyUsage, nodeId: session?.node_id ?? null,
    selectedNodeId: selectedUsageNodeId, api });
  React.useEffect(() => {
    if (!session?.node_id || usageConfiguredNodeId === session.node_id) return;
    useSettingsStore.getState().setPersistentSessionWeeklyUsageNodeSelection(serverUrl, email,
      { configuredNodeId: session.node_id, selectedNodeId: null });
  }, [email, serverUrl, session?.node_id, usageConfiguredNodeId]);
  const measureApp = React.useCallback(() => appRef.current?.measureInWindow((left, top, width, height) => {
    if (width > 0 && height > 0) setApp({ left, top, width, height });
  }), []);
  const measureMain = React.useCallback(() => mainRef.current?.measureInWindow((left, top, width, height) => {
    if (width > 0 && height > 0) setMain({ left, top, width, height });
  }), []);
  // RN 웹은 크기가 같은 열의 x 이동만으로 onLayout을 다시 보내지 않는다.
  // 열 배치를 바꾼 commit 뒤에도 같은 window 좌표계로 실측한다.
  React.useLayoutEffect(measureMain, [measureMain, columnLeft, columnWidth, headerHeight, app?.height]);
  const composerRoles = createSessionVisualRoles(t).chat.composer;
  const inputRowHeight = Math.max(composerRoles.contentMinHeight,
    t.chatFontSize.body * t.lineHeightRatio * fontScale + composerRoles.inputPaddingVertical * 2);
  // The composer anchor moves when the inline report grows; keep its cap and portrait line tied to the main column.
  const nextGeometry = app && main && composer ? calculatePersistentSessionLayout({
    app,
    header: { left: app.left, top: app.top, width: app.width, height: headerHeight },
    main,
    baselineBottom: main.top + main.height - keyboardOverlap - (composer.anchor.height - (composer.box.y + composer.box.height)),
    inputRowHeight, rowBottomGap: t.spacing.xs, pointerFine: false, showCharacter: display?.show_character === true,
    inlineComposerReserve: composer.anchor.height + keyboardOverlap, phoneConfigured: phone || compact,
    reportBubble: { widthScale: 1, minimumHeight: minimumReportBubbleHeight(t) },
  }) : null;
  const heldGeometry = React.useRef(nextGeometry);
  const previousSize = React.useRef([app?.width, app?.height]);
  const resized = previousSize.current[0] !== app?.width || previousSize.current[1] !== app?.height;
  if (!reportPressed || resized) heldGeometry.current = nextGeometry;
  previousSize.current = [app?.width, app?.height];
  const geometry = heldGeometry.current;
  const pager = geometry ? <PersistentReportPager entries={reportSend.entries} index={report.index} api={api}
    key={`report-${session?.session_id}`} expandedKey={expandedReportKey}
    onExpandedKeyChange={key => setReportExpansion({ sessionId: session?.session_id, key })}
    sessionId={session?.session_id} onReady={setReportReady}
    send={reportSend} completion={completion} bubble={!reportsScene && !!geometry.reportBubble} verticalList={reportsScene}
    revealKey={reportsScene ? revealReportKey : null} onRevealed={() => setRevealReportKey(null)}
    maxHeight={reportsScene ? (phone ? Math.max(0, (app?.height ?? 0) - headerHeight - keyboardOverlap) : geometry.reportInlineMaxHeight)
      : geometry.reportBubble?.maxHeight ?? (phone ? Math.min(geometry.reportViewMaxHeight, geometry.reportInlineMaxHeight) : geometry.reportInlineMaxHeight)}
    onSelect={report.select} onDismiss={report.dismiss} onInteraction={setReportPressed} onDeckTouch={onReportDeckTouch}
    renderCardStatus={entry => {
      const card = persistentReportStatusCard(entry);
      return card ? <CardStatusChip card={card} detail /> : null;
    }}
    renderCardDetails={!phone && !reportsScene ? entry => <PersistentReportCardExpansion key={entry.key} api={api} entry={entry} /> : undefined}
    onOpenCardDetails={phone || reportsScene ? openReportCardDirectly : undefined}
    onFocusComposer={() => inputComposerRef.current?.focusAccessibility()} /> : null;
  const back = React.useCallback(() => {
    const state = host.store.getState();
    if (state.scene === 'cards' || (reportsListMode && state.scene === 'reports')) {
      if (state.selectedCardId) state.closeCard();
      else state.swipe('right');
      return true;
    }
    return false;
  }, [host.store, reportsListMode]);
  React.useEffect(() => {
    if (!active) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', back);
    return () => sub.remove();
  }, [active, back]);
  const gestures = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_event, state) => !reportTouch.current && Math.abs(state.dx) > t.hitTarget.min && Math.abs(state.dx) > Math.abs(state.dy),
    onPanResponderRelease: (_event, state) => host.store.getState().swipe(state.dx < 0 ? 'left' : 'right'),
  }), [host.store, t.hitTarget.min]);
  async function toggleCharacter() {
    if (!api || !session || savingCharacter) return;
    setSavingCharacter(true);
    try {
      const saved = await savePersistentSessionSettings(api, session.session_id, { show_character: !display?.show_character });
      useChatStore.getState().applyPersistentDisplaySettings(session.session_id, persistentChatDisplaySettings(saved));
    } catch { Alert.alert('캐릭터 표시를 저장하지 못했습니다', '다시 시도해 주세요.'); }
    finally { setSavingCharacter(false); }
  }
  const action = (icon: React.ComponentProps<typeof Ionicons>['name'], label: string, onPress: () => void, testID: string, selected?: boolean) =>
    <LiquidGlassButton iconOnly variant="plain" size="compact" accessibilityLabel={label}
      accessibilityState={selected === undefined ? undefined : { selected }} aria-pressed={selected}
      onPress={onPress} testID={testID} surfaceTestID={`${testID}-visual`}>
      <Ionicons name={icon} size={t.iconSize.navigation} color={selected ? t.colors.accent : t.colors.textPrimary} />
    </LiquidGlassButton>;
  const weeklyUsage = <PersistentSessionWeeklyUsage node={usageSummary.node} gauges={usageSummary.gauges}
    loading={usageSummary.loading} loadState={usageSummary.loadState}
    evaluatedAtMs={usageSummary.evaluatedAtMs} onRetry={usageSummary.retry}
    onNextNode={() => {
      if (!session?.node_id) return;
      const nextNodeId = nextUsageSummaryNodeId(usageSummary.summary, usageSummary.node?.nodeId ?? null);
      if (!nextNodeId) return;
      useSettingsStore.getState().setPersistentSessionWeeklyUsageNodeSelection(serverUrl, email,
        { configuredNodeId: session.node_id, selectedNodeId: nextNodeId });
    }} />;
  const taskList = <PersistentSessionTaskList api={api} visible={!selectedCardId}
    onOpenCard={openCard} />;
  const renderRailAction = (item: PhoneRailAction) => {
    const testID = railOverride?.length ? `duo-rail-action-${item.id}` : `persistent-session-duo-${item.id}`;
    return <RailCapsuleItem key={item.id} testID={testID} label={item.label} selected={item.selected}
      badgeCount={item.badgeCount} dot={item.dot} disabled={item.disabled} onPress={item.onPress}>
      <Ionicons name={item.icon} size={t.iconSize.standard} color={item.selected ? t.colors.accent : t.colors.textMuted} />
    </RailCapsuleItem>;
  };
  return <SafeAreaView testID="persistent-session-safe-area" edges={phone
    ? duoSideBand ? ['top', 'left'] : railMode ? ['top', 'bottom', 'left'] : ['top', 'left', 'right']
    : duoTopBand ? ['left', 'right'] : ['top', 'left', 'right']}
    style={{ flex: 1, backgroundColor: t.persistentSession.paper }}>
    {/* Keep native z-index stacking inside PAS so overlays cannot cover the Duo rail. */}
    <View ref={appRef} testID="persistent-session-screen" style={{ flex: 1, isolation: 'isolate' }} onLayout={measureApp} {...(phone ? gestures.panHandlers : {})}>
      <View testID="persistent-session-header" style={{ height: headerHeight, flexDirection: 'row', alignItems: 'center',
        paddingTop: topBandInset,
        paddingLeft: t.foundation.pageInset, paddingRight: duoTopBand ? DUO_TOP_BAND_STATUS_RESERVE : t.foundation.pageInset - (t.hitTarget.min - t.foundation.iconFrame.compact) / 2,
        gap: t.uiSpacing.sm }}>
        {phone
          ? <Text numberOfLines={1} style={{ flex: 1, ...t.foundation.typography.navigation, color: t.colors.textPrimary }}>{session?.agent_name ?? ''}</Text>
          : <View style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: t.spacing.lg }}>
            <Text style={{ ...t.foundation.typography.navigation, color: t.colors.textPrimary }}>소울스트림</Text>
            <Text numberOfLines={1} style={{ flex: 1, ...t.foundation.typography.body, color: t.colors.textMuted }}>{session?.agent_name ?? ''}</Text>
          </View>}
        {!duoSideBand && !duoTopBand ? <>
          {!phone ? action('home-outline', '홈으로 돌아가기', onHome, 'persistent-session-home') : null}
          {!phone && hasMultiplePas ? action('swap-horizontal-outline', '영구 세션 선택', () => void host.requestEntry(() => {}, false, true), 'persistent-session-switch') : null}
          {action(t.mode === 'light' ? 'moon-outline' : 'sunny-outline', '밝기 전환', () => void handleAppearanceChange(t.mode === 'light' ? 'dark' : 'light'), 'persistent-session-appearance')}
          {!phone && session?.node_id ? action('speedometer-outline', '주간 사용량', () => {
            useSettingsStore.getState().setPersistentSessionShowWeeklyUsage(serverUrl, email, !showWeeklyUsage);
          }, 'persistent-session-weekly-usage-toggle', showWeeklyUsage) : null}
          {action('options-outline', '영구 세션 설정', () => setSettingsOpen(true), 'persistent-session-settings')}
          {phone ? action('list-outline', scene === 'cards' ? 'PAS 대화로 돌아가기' : '카드 목록 보기', () => host.store.getState().toggleScene(), 'persistent-session-tasks') : null}
        </> : null}
      </View>
      {!phone && hasWeeklyUsage && !usageInColumn && app && geometry ? <View testID="persistent-session-weekly-usage-seat" onLayout={event => {
        const height = event.nativeEvent.layout.height;
        setUsageHeight(current => current === height ? current : height);
      }} style={{ position: 'absolute', right: t.foundation.pageInset, width: widths.tasks - 2 * t.uiSpacing.sm,
        bottom: app.height - geometry.lineY }}>
        {weeklyUsage}
      </View> : null}
      <View ref={mainRef} testID="persistent-session-conversation" pointerEvents={phoneCardsScene || (phone && reportsScene) ? 'none' : 'auto'}
        accessibilityElementsHidden={phoneCardsScene || (phone && reportsScene)} importantForAccessibility={phoneCardsScene || (phone && reportsScene) ? 'no-hide-descendants' : 'auto'}
        style={{ position: 'absolute', top: headerHeight, bottom: 0, left: columnLeft, width: columnWidth,
          opacity: hidePhoneConversation ? 0 : 1 }} onLayout={measureMain}>
        <ChatBody sessionId={session?.session_id} presentation="manuscript" showSessionAuxiliary={false}
          onOpenReportCard={openCard}
          inputComposerRef={inputComposerRef} getReportSendContext={(text, reply) => report.getSendContext(text, reply, !reportsListMode || reportsScene)}
          reportView={reportsListMode ? null : geometry?.reportBubble ? null : phone ? pager : geometry && (report.entries.length > 0 || completion.recent)
            ? <View testID="persistent-session-report-inline-space" style={{ height: reportSeatHeight }} /> : null}
          active={chatActive} minimumBottomPadding={bottomSafeAreaInset}
          onKeyboardOverlapChange={onKeyboardOverlapChange}
          onComposerLayout={(anchor: LayoutRectangle, box: LayoutRectangle) => {
            if (anchor.width > 0 && anchor.height > 0 && box.width > 0 && box.height > 0) setComposer({ anchor, box });
          }} />
      </View>
      {phone && reportsScene ? <View testID="persistent-session-reports-panel" style={{ position: 'absolute', top: headerHeight, bottom: keyboardOverlap, left: 0, right: 0,
        backgroundColor: t.persistentSession.paper, paddingHorizontal: t.foundation.pageInset,
        paddingTop: t.uiSpacing.sm, paddingBottom: 0, minHeight: 0 }}>{pager}</View> : null}
      {geometry && !(phone && reportsScene) ? <View testID="persistent-session-baseline" pointerEvents="none" style={{ position: 'absolute',
        left: columnLeft - geometry.lineLeftReach, top: geometry.lineY,
        width: columnWidth + geometry.lineLeftReach, height: StyleSheet.hairlineWidth, backgroundColor: t.persistentSession.line }} /> : null}
      {!phone && geometry?.body ? <View testID="persistent-session-character-seat" pointerEvents="none" style={{ position: 'absolute',
        left: geometry.body.left, top: geometry.body.top, width: geometry.body.width, height: geometry.body.height }}>
        <SwayCharacter width={geometry.body.width} height={geometry.body.height} shown motionEnabled={display?.animate_character === true}
          active={active && !settingsOpen} />
      </View> : null}
      {!phone && !reportsListMode && geometry && (report.entries.length > 0 || completion.recent) ? <View
        testID={geometry.reportBubble ? 'persistent-session-report-bubble-seat' : 'persistent-session-report-inline-seat'}
        pointerEvents={reportReady ? 'auto' : 'none'} accessibilityElementsHidden={!reportReady}
        onLayout={event => setReportSeatHeight(event.nativeEvent.layout.height)}
        style={{ position: 'absolute', ...(geometry.reportBubble
          ? { left: geometry.reportBubble.left, bottom: (app?.height ?? 0) - geometry.reportBubble.bottom,
            width: geometry.reportBubble.width, maxHeight: geometry.reportBubble.maxHeight }
          : { left: columnLeft, top: headerHeight, width: columnWidth }), opacity: reportReady ? 1 : 0 }}>
        {pager}
        {geometry.reportBubble ? <View testID="report-tail" pointerEvents="none" style={{ position: 'absolute',
          left: geometry.reportBubble.tailLeft - t.uiSpacing.lg / 2, bottom: -t.uiSpacing.lg / 2,
          width: t.uiSpacing.lg, height: t.uiSpacing.lg, backgroundColor: t.persistentSession.panel,
          borderRightWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: t.persistentSession.line,
          transform: [{ skewX: geometry.reportBubble.tailDirection === 'left' ? '-45deg' : '45deg' }, { rotate: '45deg' }] }} /> : null}
      </View> : null}
      {!phone && reportsScene && geometry ? <View testID="persistent-session-reports-cover" style={{ position: 'absolute',
        left: columnLeft, width: columnWidth, top: headerHeight, height: geometry.reportInlineMaxHeight, minHeight: 0, overflow: 'hidden',
        backgroundColor: t.persistentSession.paper }}>{pager}</View> : null}
      {!phone && geometry?.toggle ? <View testID="persistent-session-character-toggle-seat" style={{ position: 'absolute',
        left: geometry.toggle.left + (geometry.toggle.width - t.hitTarget.min) / 2,
        top: geometry.toggle.top + (geometry.toggle.height - t.hitTarget.min) / 2 }}>
        <LiquidGlassButton iconOnly size="compact" variant="plain" disabled={savingCharacter} testID="persistent-session-character-toggle"
          accessibilityLabel={display?.show_character ? '캐릭터 숨기기' : '캐릭터 표시'}
          onPress={() => void toggleCharacter()}>
          <MaterialCommunityIcons
            testID="persistent-session-character-toggle-icon"
            name={display?.show_character ? 'account-off-outline' : 'account-outline'}
            size={t.iconSize.navigation} color={display?.show_character ? t.colors.textPrimary : t.colors.textMuted} />
        </LiquidGlassButton>
      </View> : null}
      {!phone && !duoSideBand && !duoTopBand ? <View style={{ position: 'absolute', top: headerHeight, right: t.foundation.pageInset - (t.hitTarget.min - t.foundation.iconFrame.compact) / 2 }}>
        {action('list-outline', scene === 'cards' ? 'PAS 대화로 돌아가기' : '카드 목록 보기', () => host.store.getState().toggleScene(), 'persistent-session-tasks')}
      </View> : null}
      {usageInColumn ? <View testID="persistent-session-usage-column" style={{ position: 'absolute',
        top: headerHeight + rightControlsHeight,
        bottom: duoTopBand ? railColumnBottom : Math.max(insets.bottom, keyboardOverlap), right: rightColumnOffset,
        width: widths.tasks, paddingHorizontal: t.uiSpacing.sm, gap: t.spacing.xl }}>
        {weeklyUsage}
        {scene === 'cards' ? <View testID="persistent-session-card-panel" style={{ flex: 1, minHeight: 0 }}>
          {taskList}
        </View> : null}
      </View> : null}
      {scene === 'cards' && !usageInColumn ? <View testID="persistent-session-card-panel" style={{ position: 'absolute',
        top: phone || duoSideBand ? headerHeight : headerHeight + rightControlsHeight,
        ...(phone ? { bottom: 0 } : { maxHeight: duoTopBand ? Math.max(0, (app?.height ?? windowHeight) - railColumnBottom - headerHeight - rightControlsHeight)
          : !phone && hasWeeklyUsage && geometry
          ? Math.max(0, geometry.lineY - usageHeight - t.spacing.xl - (headerHeight + rightControlsHeight))
          : Math.max(0, (portrait && geometry ? geometry.lineY : app?.height ?? 0) - headerHeight - rightControlsHeight - t.uiSpacing.md) }),
        right: phone ? 0 : rightColumnOffset,
        width: phone ? '100%' : widths.tasks,
        backgroundColor: t.persistentSession.paper,
        borderRadius: phone ? 0 : t.foundation.radius.card,
        borderWidth: 0, borderColor: t.persistentSession.line,
        paddingHorizontal: phone ? t.foundation.pageInset : t.uiSpacing.sm,
        paddingTop: phone ? t.uiSpacing.md : 0, paddingBottom: phone ? 0 : bottomSafeAreaInset }}>
        {taskList}
      </View> : null}
      <PersistentSessionCardOverlay api={api} cardId={scene === 'cards' || reportsScene ? selectedCardId : null}
        sessionId={session?.session_id} bottomSafeAreaInset={bottomSafeAreaInset}
        sheetTop={duoTopBand ? headerHeight : 0} railBand={duoTopBand} onClose={() => host.store.getState().closeCard()} />
      {settingsOpen && session ? <PersistentSessionPasSettingsModal sessionId={session.session_id} nodeId={session.node_id ?? ''}
        onClose={() => setSettingsOpen(false)} /> : null}
    </View>
    {!phone && (duoSideBand || duoTopBand) && railLayout.exit ? <View style={{ position: 'absolute',
      top: duoTopBand ? DUO_TOP_BAND_RAIL_TOP : getDuoRailTopOffset(windowWidth, windowHeight),
      right: duoTopBand ? DUO_RAIL_CENTER_FROM_END - RAIL_CAPSULE_WIDTH / 2 : (insets.right - RAIL_CAPSULE_WIDTH + DUO_RAIL_END_INSET) / 2 }}>
      <RailCapsule testID="duo-rail-back-capsule" compact={railLayout.compact}>{renderRailAction(railLayout.exit)}</RailCapsule>
    </View> : null}
    {!phone && (duoSideBand || duoTopBand) && railLayout.screen.length ? <View testID="persistent-session-duo-band" style={{
      position: 'absolute', bottom: railBottom, alignItems: 'center',
      ...(duoTopBand ? { right: DUO_RAIL_CENTER_FROM_END - RAIL_CAPSULE_WIDTH / 2 }
        : { right: 0, width: insets.right, paddingRight: DUO_RAIL_END_INSET }) }}>
      <RailCapsule testID="persistent-session-duo-capsule" compact={railLayout.compact}>
        {railLayout.screen.map(renderRailAction)}
      </RailCapsule>
    </View> : null}
  </SafeAreaView>;
}
