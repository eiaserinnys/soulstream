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
import { PersistentReportCardSheetHeader } from '../components/persistent/PersistentReportCardSheetHeader';
import { PersistentReportCardSheetComplete } from '../components/persistent/PersistentReportCardSheetComplete';
import { usePersistentCardCompletion } from '../components/persistent/usePersistentCardCompletion';
import { minimumReportBubbleHeight } from '../components/persistent/persistentReportStyles';
import { LiquidGlassButton } from '../components/LiquidGlassButton';
import { PersistentSessionCardOverlay } from '../components/persistent/PersistentSessionCardOverlay';
import { PersistentReportCardExpansion } from '../components/persistent/PersistentReportCardExpansion';
import { ReportComposerFocusContext, useReportComposerScroll } from '../components/persistent/useReportComposerScroll';
import { PersistentSessionTaskList } from '../components/persistent/PersistentSessionTaskList';
import { SwayCharacter } from '../components/persistent/SwayCharacter';
import { PERSISTENT_SESSION_FRAME as FRAME } from '../components/persistent/persistentSessionFrame';
import { PersistentSessionPasSettingsModal } from '../components/settings/PersistentSessionPasSettingsModal';
import { persistentChatDisplaySettings, savePersistentSessionSettings } from '../components/settings/persistentSessionSettingsActions';
import { useDisplayPreferenceActions } from '../components/settings/useDisplayPreferenceActions';
import { AppModalSurface } from '../components/AppModalSurface';
import { GlassButton } from '../components/GlassSurface';
import { CardStatusChip } from '../components/planner/CardRow';
import { PersistentSessionWeeklyUsage } from '../components/persistent/PersistentSessionWeeklyUsage';
import { useUsageSummary } from '../hooks/useUsageSummary';
import { useOpenContentLink } from '../hooks/useOpenContentLink';
import { decodeAuthJwt } from '../auth/jwt-payload';
import { usePersistentSessionHost, usePersistentSessionScene } from '../navigation/PersistentSessionContext';
import { useDuoSideBand, usePhoneRailMode } from '../navigation/tabContract';
import { RailCapsule, RailCapsuleItem } from '../components/navigation/RailCapsule';
import { usePasContextMenu } from '../components/persistent/usePasContextMenu';
import { useAuthStore } from '../store/authStore';
import { useChatStore } from '../store/chatStore';
import { useSessionStore } from '../store/sessionStore';
import { useSettingsStore } from '../store/settingsStore';
import { createSessionVisualRoles, useDeviceType, useTokens } from '../theme';
import type { PersistentReportEntry } from '../api/types';
import { isPersistentReportCardExpandable, persistentReportStatusCard } from '../lib/persistent-report-card';
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
  const { fontScale } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const host = usePersistentSessionHost();
  const session = usePersistentSessionScene(state => state.session);
  const scene = usePersistentSessionScene(state => state.scene);
  const selectedCardId = usePersistentSessionScene(state => state.selectedCardId);
  const phoneCardsScene = phone && scene === 'cards';
  const hidePhoneConversation = phoneCardsScene && !selectedCardId;
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
  const status = useSessionStore(state => session ? state.sessions[session.session_id]?.status : undefined);
  const reportSend = usePersistentReportSend(session?.session_id ?? '', api, report.entries, report.server, status, setNotice);
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
  const showPasMenu = usePasContextMenu(phone ? undefined : onHome);
  React.useLayoutEffect(() => {
    if (savedPas?.settingsOpen !== undefined) setSettingsOpen(savedPas.settingsOpen);
  }, []);
  const [reportCard, setReportCard] = useState<PersistentReportEntry | null>(() => report.entries.find(entry => entry.key === savedPas?.expandedKey) ?? null);
  const [reportCardSheetEntry, setReportCardSheetEntry] = useState<PersistentReportEntry | null>(() => report.entries.find(entry => entry.key === savedPas?.expandedKey) ?? null);
  const reportCardScroll = useReportComposerScroll();
  const [reportExpansion, setReportExpansion] = useState<{ sessionId?: string; key: string | null }>({ sessionId: session?.session_id, key: savedPas?.expandedKey ?? null });
  const expandedReportKey = reportExpansion.sessionId === session?.session_id ? reportExpansion.key : null;
  React.useEffect(() => {
    continuity?.setViewState(pasKey, { ...continuity.getViewState<object>(pasKey), settingsOpen,
      expandedKey: phone ? reportCard?.key ?? null : expandedReportKey });
  }, [continuity, pasKey, settingsOpen, phone, reportCard?.key, expandedReportKey]);
  const [reportSeatHeight, setReportSeatHeight] = useState(0);
  const pendingReportCardLink = React.useRef<string | null>(null);
  const openContentLink = useOpenContentLink();
  const showReportCard = React.useCallback((entry: PersistentReportEntry) => {
    pendingReportCardLink.current = null;
    setReportCard(entry);
    setReportCardSheetEntry(entry);
  }, []);
  const closeReportCard = React.useCallback(() => {
    setReportCard(null);
  }, []);
  const openReportCardFromSheet = React.useCallback((cardId: string) => {
    pendingReportCardLink.current = cardId;
    closeReportCard();
  }, [closeReportCard]);
  const onReportCardSheetDismiss = React.useCallback(() => {
    const cardId = pendingReportCardLink.current;
    pendingReportCardLink.current = null;
    setReportCardSheetEntry(null);
    if (cardId) void openContentLink(`/?card=${encodeURIComponent(cardId)}`);
  }, [openContentLink]);
  const [savingCharacter, setSavingCharacter] = useState(false);
  const appRef = React.useRef<View>(null);
  const mainRef = React.useRef<View>(null);
  const [app, setApp] = useState<PersistentSessionRect | null>(null);
  const [main, setMain] = useState<PersistentSessionRect | null>(null);
  const [composer, setComposer] = useState<{ anchor: LayoutRectangle; box: LayoutRectangle } | null>(null);
  const [keyboardOverlap, setKeyboardOverlap] = useState(0);
  const onKeyboardOverlapChange = React.useCallback((overlap: number) => {
    setKeyboardOverlap(current => current === overlap ? current : overlap);
  }, []);
  const [usageHeight, setUsageHeight] = useState(0);
  const compact = phone || (app?.height ?? Infinity) < FRAME.compactHeight;
  const headerHeight = duoSideBand ? 0 : compact ? FRAME.compactHeader : FRAME.header;
  const portrait = app ? app.height > app.width : false;
  const widths = portrait ? FRAME.portrait : FRAME.landscape;
  const hasWeeklyUsage = Boolean(session?.node_id && showWeeklyUsage);
  const usageInColumn = !!app && !phone && hasWeeklyUsage
    && (app.width + widths.conversation) / 2 > app.width - t.foundation.pageInset - (widths.tasks - 2 * t.uiSpacing.sm);
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
      cardPanelRightOffset: t.foundation.pageInset - t.uiSpacing.sm,
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
    send={reportSend} completion={completion} bubble={!!geometry.reportBubble}
    maxHeight={geometry.reportBubble?.maxHeight ?? (phone ? geometry.reportViewMaxHeight : geometry.reportInlineMaxHeight)}
    onSelect={report.select} onDismiss={report.dismiss} onInteraction={setReportPressed} onDeckTouch={onReportDeckTouch}
    renderCardStatus={entry => {
      const card = persistentReportStatusCard(entry);
      return card ? <CardStatusChip card={card} detail /> : null;
    }}
    renderCardDetails={!phone ? entry => <PersistentReportCardExpansion key={entry.key} api={api} entry={entry} /> : undefined}
    onOpenCardDetails={phone ? showReportCard : undefined}
    onFocusComposer={() => inputComposerRef.current?.focusAccessibility()} /> : null;
  const back = React.useCallback(() => {
    const state = host.store.getState();
    if (state.scene === 'cards') {
      if (state.selectedCardId) state.selectCard(null);
      else state.swipe('right');
      return true;
    }
    return false;
  }, [host.store]);
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
    onOpenCard={cardId => phone && onOpenPhoneCard ? onOpenPhoneCard(cardId) : host.store.getState().selectCard(cardId)} />;
  return <SafeAreaView testID="persistent-session-safe-area" edges={phone
    ? railMode ? ['top', 'bottom', 'left'] : ['top', 'left', 'right']
    : ['top', 'left', 'right']}
    style={{ flex: 1, backgroundColor: t.persistentSession.paper }}>
    <View ref={appRef} testID="persistent-session-screen" style={{ flex: 1 }} onLayout={measureApp} {...(phone ? gestures.panHandlers : {})}>
      {!duoSideBand ? <View testID="persistent-session-header" style={{ height: headerHeight, flexDirection: 'row', alignItems: 'center',
        paddingLeft: t.foundation.pageInset, paddingRight: t.foundation.pageInset - (t.hitTarget.min - t.foundation.iconFrame.compact) / 2,
        gap: t.uiSpacing.sm }}>
        {phone
          ? <Text numberOfLines={1} style={{ flex: 1, ...t.foundation.typography.navigation, color: t.colors.textPrimary }}>{session?.agent_name ?? ''}</Text>
          : <View style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: t.spacing.lg }}>
            <Text style={{ ...t.foundation.typography.navigation, color: t.colors.textPrimary }}>소울스트림</Text>
            <Text numberOfLines={1} style={{ flex: 1, ...t.foundation.typography.body, color: t.colors.textMuted }}>{session?.agent_name ?? ''}</Text>
          </View>}
        {!phone ? action('home-outline', '홈으로 돌아가기', onHome, 'persistent-session-home') : null}
        {action(t.mode === 'light' ? 'moon-outline' : 'sunny-outline', '밝기 전환', () => void handleAppearanceChange(t.mode === 'light' ? 'dark' : 'light'), 'persistent-session-appearance')}
        {!phone && session?.node_id ? action('speedometer-outline', '주간 사용량', () => {
          useSettingsStore.getState().setPersistentSessionShowWeeklyUsage(serverUrl, email, !showWeeklyUsage);
        }, 'persistent-session-weekly-usage-toggle', showWeeklyUsage) : null}
        {action('options-outline', '영구 세션 설정', () => setSettingsOpen(true), 'persistent-session-settings')}
        {phone ? action('list-outline', scene === 'cards' ? 'PAS 대화로 돌아가기' : '카드 목록 보기', () => host.store.getState().toggleScene(), 'persistent-session-tasks') : null}
      </View> : null}
      {!phone && hasWeeklyUsage && !usageInColumn && app && geometry ? <View testID="persistent-session-weekly-usage-seat" onLayout={event => {
        const height = event.nativeEvent.layout.height;
        setUsageHeight(current => current === height ? current : height);
      }} style={{ position: 'absolute', right: t.foundation.pageInset, width: widths.tasks - 2 * t.uiSpacing.sm,
        bottom: app.height - geometry.lineY }}>
        {weeklyUsage}
      </View> : null}
      <View ref={mainRef} testID="persistent-session-conversation" pointerEvents={phoneCardsScene ? 'none' : 'auto'}
        accessibilityElementsHidden={phoneCardsScene} importantForAccessibility={phoneCardsScene ? 'no-hide-descendants' : 'auto'}
        style={{ position: 'absolute', top: headerHeight, bottom: 0, left: columnLeft, width: columnWidth,
          opacity: hidePhoneConversation ? 0 : 1 }} onLayout={measureMain}>
        <ChatBody sessionId={session?.session_id} presentation="manuscript" showSessionAuxiliary={false}
          inputComposerRef={inputComposerRef} getReportSendContext={report.getSendContext}
          reportView={geometry?.reportBubble ? null : phone ? pager : geometry && (report.entries.length > 0 || completion.recent)
            ? <View testID="persistent-session-report-inline-space" style={{ height: reportSeatHeight }} /> : null}
          active={chatActive} minimumBottomPadding={phone ? 0 : insets.bottom}
          onKeyboardOverlapChange={onKeyboardOverlapChange}
          onComposerLayout={(anchor: LayoutRectangle, box: LayoutRectangle) => {
            if (anchor.width > 0 && anchor.height > 0 && box.width > 0 && box.height > 0) setComposer({ anchor, box });
          }} />
      </View>
      {geometry ? <View testID="persistent-session-baseline" pointerEvents="none" style={{ position: 'absolute',
        left: columnLeft - geometry.lineLeftReach, top: geometry.lineY,
        width: columnWidth + geometry.lineLeftReach, height: StyleSheet.hairlineWidth, backgroundColor: t.persistentSession.line }} /> : null}
      {!phone && geometry?.body ? <View testID="persistent-session-character-seat" pointerEvents="none" style={{ position: 'absolute',
        left: geometry.body.left, top: geometry.body.top, width: geometry.body.width, height: geometry.body.height }}>
        <SwayCharacter width={geometry.body.width} height={geometry.body.height} shown motionEnabled={display?.animate_character === true}
          active={active && !settingsOpen} />
      </View> : null}
      {!phone && geometry && (report.entries.length > 0 || completion.recent) ? <View
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
      {!phone && !duoSideBand ? <View style={{ position: 'absolute', top: headerHeight, right: t.foundation.pageInset - (t.hitTarget.min - t.foundation.iconFrame.compact) / 2 }}>
        {action('list-outline', scene === 'cards' ? 'PAS 대화로 돌아가기' : '카드 목록 보기', () => host.store.getState().toggleScene(), 'persistent-session-tasks')}
      </View> : null}
      {usageInColumn ? <View testID="persistent-session-usage-column" style={{ position: 'absolute',
        top: headerHeight + (duoSideBand ? 0 : t.hitTarget.min),
        bottom: Math.max(insets.bottom, keyboardOverlap), right: t.foundation.pageInset - t.uiSpacing.sm,
        width: widths.tasks, paddingHorizontal: t.uiSpacing.sm, gap: t.spacing.xl }}>
        {weeklyUsage}
        {scene === 'cards' ? <View testID="persistent-session-card-panel" style={{ flex: 1, minHeight: 0 }}>
          {taskList}
        </View> : null}
      </View> : null}
      {scene === 'cards' && !usageInColumn ? <View testID="persistent-session-card-panel" style={{ position: 'absolute',
        top: phone || duoSideBand ? headerHeight : headerHeight + t.hitTarget.min,
        ...(phone ? { bottom: 0 } : { maxHeight: !phone && hasWeeklyUsage && geometry
          ? Math.max(0, geometry.lineY - usageHeight - t.spacing.xl - (headerHeight + t.hitTarget.min))
          : Math.max(0, (portrait && geometry ? geometry.lineY : app?.height ?? 0) - headerHeight - (duoSideBand ? 0 : t.hitTarget.min) - t.uiSpacing.md) }),
        right: phone ? 0 : t.foundation.pageInset - t.uiSpacing.sm,
        width: phone ? '100%' : widths.tasks,
        backgroundColor: t.persistentSession.paper,
        borderRadius: phone ? 0 : t.foundation.radius.card,
        borderWidth: 0, borderColor: t.persistentSession.line,
        paddingHorizontal: phone ? t.foundation.pageInset : t.uiSpacing.sm,
        paddingTop: phone ? t.uiSpacing.md : 0, paddingBottom: phone ? 0 : insets.bottom }}>
        {taskList}
      </View> : null}
      <PersistentSessionCardOverlay api={api} cardId={scene === 'cards' ? selectedCardId : null}
        sessionId={session?.session_id} bottomSafeAreaInset={insets.bottom}
        onClose={() => host.store.getState().selectCard(null)} />
      {settingsOpen && session ? <PersistentSessionPasSettingsModal sessionId={session.session_id} nodeId={session.node_id ?? ''}
        onClose={() => setSettingsOpen(false)} /> : null}
    </View>
    {!phone && duoSideBand ? <View testID="persistent-session-duo-band" style={{ position: 'absolute', right: 0,
      bottom: Math.max(keyboardOverlap, insets.bottom, t.uiSpacing.xxl), width: insets.right, alignItems: 'center' }}>
      <RailCapsule testID="persistent-session-duo-capsule">
        <RailCapsuleItem testID="persistent-session-duo-tasks" label={scene === 'cards' ? 'PAS 대화로 돌아가기' : '카드 목록 보기'}
          onPress={() => host.store.getState().toggleScene()}>
          <Ionicons name="list-outline" size={t.iconSize.standard} color={t.colors.textMuted} />
        </RailCapsuleItem>
        {session?.node_id ? <RailCapsuleItem testID="persistent-session-duo-usage" label="주간 사용량" selected={showWeeklyUsage}
          onPress={() => useSettingsStore.getState().setPersistentSessionShowWeeklyUsage(serverUrl, email, !showWeeklyUsage)}>
          <Ionicons name="speedometer-outline" size={t.iconSize.standard} color={showWeeklyUsage ? t.colors.accent : t.colors.textMuted} />
        </RailCapsuleItem> : null}
        <RailCapsuleItem testID="persistent-session-duo-menu" label="PAS 메뉴" onPress={showPasMenu}>
          <Ionicons name="ellipsis-horizontal" size={t.iconSize.standard} color={t.colors.textMuted} />
        </RailCapsuleItem>
      </RailCapsule>
    </View> : null}
    {phone && reportCardSheetEntry && isPersistentReportCardExpandable(reportCardSheetEntry) ? <AppModalSurface visible={reportCard !== null} modalId="modal_card_detail"
      variant="expanded" presentationStyle="pageSheet" onRequestClose={closeReportCard} onDismiss={onReportCardSheetDismiss} surfaceTestID="persistent-session-report-card-sheet">
      <PersistentReportCardSheetHeader entry={reportCardSheetEntry} onCollapse={closeReportCard} />
      <ScrollView style={{ flex: 1, minHeight: 0 }} ref={reportCardScroll.scroll} contentContainerStyle={{ padding: t.foundation.pageInset }}
        onLayout={reportCardScroll.keepComposerVisible} onContentSizeChange={reportCardScroll.keepComposerVisible}
        showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive"
        automaticallyAdjustKeyboardInsets={Platform.OS === 'ios'}>
        <ReportComposerFocusContext.Provider value={reportCardScroll.onFocusChange}>
          <PersistentReportCardExpansion key={reportCardSheetEntry.key} api={api} entry={reportCardSheetEntry} onOpenCard={openReportCardFromSheet} />
          <PersistentReportCardSheetComplete key={'complete-' + reportCardSheetEntry.key} entry={reportCardSheetEntry}
            completion={completion} onCompleted={closeReportCard} />
        </ReportComposerFocusContext.Provider>
      </ScrollView>
    </AppModalSurface> : null}
  </SafeAreaView>;
}
