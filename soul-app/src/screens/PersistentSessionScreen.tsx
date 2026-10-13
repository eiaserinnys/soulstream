import React, { useMemo, useState } from 'react';
import { Alert, BackHandler, PanResponder, StyleSheet, Text, View, useWindowDimensions, type LayoutRectangle } from 'react-native';
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
import { minimumReportBubbleHeight } from '../components/persistent/persistentReportStyles';
import { LiquidGlassButton } from '../components/LiquidGlassButton';
import { PersistentSessionCardOverlay } from '../components/persistent/PersistentSessionCardOverlay';
import { PersistentSessionTaskList } from '../components/persistent/PersistentSessionTaskList';
import { SwayCharacter } from '../components/persistent/SwayCharacter';
import { PERSISTENT_SESSION_FRAME as FRAME } from '../components/persistent/persistentSessionFrame';
import { PersistentSessionPasSettingsModal } from '../components/settings/PersistentSessionPasSettingsModal';
import { persistentChatDisplaySettings, savePersistentSessionSettings } from '../components/settings/persistentSessionSettingsActions';
import { useDisplayPreferenceActions } from '../components/settings/useDisplayPreferenceActions';
import { PersistentSessionWeeklyUsage } from '../components/persistent/PersistentSessionWeeklyUsage';
import { useUsageSummary } from '../hooks/useUsageSummary';
import { decodeAuthJwt } from '../auth/jwt-payload';
import { usePersistentSessionHost, usePersistentSessionScene } from '../navigation/PersistentSessionContext';
import { useAuthStore } from '../store/authStore';
import { useChatStore } from '../store/chatStore';
import { useSessionStore } from '../store/sessionStore';
import { useSettingsStore } from '../store/settingsStore';
import { createSessionVisualRoles, useDeviceType, useTokens } from '../theme';

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
  const report = usePersistentReport(session?.session_id, true, api, session?.persistent_report, pending);
  const status = useSessionStore(state => session ? state.sessions[session.session_id]?.status : undefined);
  const reportSend = usePersistentReportSend(session?.session_id ?? '', api, report.entries, report.server, status, setNotice);
  const [reportPressed, setReportPressed] = useState(false);
  const display = useChatStore(state => session?.session_id
    ? state.persistentDisplaySettingsBySession[session.session_id]?.settings ?? null
    : null);
  const { handleAppearanceChange } = useDisplayPreferenceActions();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [savingCharacter, setSavingCharacter] = useState(false);
  const appRef = React.useRef<View>(null);
  const mainRef = React.useRef<View>(null);
  const [app, setApp] = useState<PersistentSessionRect | null>(null);
  const [main, setMain] = useState<PersistentSessionRect | null>(null);
  const [composer, setComposer] = useState<{ anchor: LayoutRectangle; box: LayoutRectangle } | null>(null);
  const [usageHeight, setUsageHeight] = useState(0);
  const compact = phone || (app?.height ?? Infinity) < FRAME.compactHeight;
  const headerHeight = compact ? FRAME.compactHeader : FRAME.header;
  const portrait = app ? app.height > app.width : false;
  const widths = portrait ? FRAME.portrait : FRAME.landscape;
  const columnWidth = phone ? Math.max(0, (app?.width ?? 0) - t.foundation.pageInset * 2) : widths.conversation;
  const columnLeft = app ? (app.width - columnWidth) / 2 : 0;
  const hasWeeklyUsage = Boolean(session?.node_id && showWeeklyUsage);
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
  const nextGeometry = app && main && composer ? calculatePersistentSessionLayout({
    app,
    header: { left: app.left, top: app.top, width: app.width, height: headerHeight },
    main,
    baselineBottom: main.top + composer.anchor.y + composer.box.y + composer.box.height,
    inputRowHeight, rowBottomGap: t.spacing.xs, pointerFine: false, showCharacter: display?.show_character === true,
    phoneConfigured: phone || compact,
    reportBubble: { widthScale: 1, minimumHeight: minimumReportBubbleHeight(t) },
  }) : null;
  const heldGeometry = React.useRef(nextGeometry);
  const previousSize = React.useRef([app?.width, app?.height]);
  const resized = previousSize.current[0] !== app?.width || previousSize.current[1] !== app?.height;
  if (!reportPressed || resized) heldGeometry.current = nextGeometry;
  previousSize.current = [app?.width, app?.height];
  const geometry = heldGeometry.current;
  const pager = <PersistentReportPager entries={reportSend.entries} index={report.index} api={api}
    send={reportSend} bubble={!!geometry?.reportBubble} maxHeight={geometry?.reportBubble?.maxHeight}
    onSelect={report.select} onDismiss={report.dismiss} onInteraction={setReportPressed}
    onFocusComposer={() => inputComposerRef.current?.focusAccessibility()} />;
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
    onMoveShouldSetPanResponder: (_event, state) => Math.abs(state.dx) > t.hitTarget.min && Math.abs(state.dx) > Math.abs(state.dy),
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
  return <SafeAreaView testID="persistent-session-safe-area" edges={['top', 'left', 'right']}
    style={{ flex: 1, backgroundColor: t.persistentSession.paper }}>
    <View ref={appRef} testID="persistent-session-screen" style={{ flex: 1 }} onLayout={measureApp} {...(phone ? gestures.panHandlers : {})}>
      <View testID="persistent-session-header" style={{ height: headerHeight, flexDirection: 'row', alignItems: 'center',
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
      </View>
      {!phone && hasWeeklyUsage && app && geometry ? <View testID="persistent-session-weekly-usage-seat" onLayout={event => {
        const height = event.nativeEvent.layout.height;
        setUsageHeight(current => current === height ? current : height);
      }} style={{ position: 'absolute', right: t.foundation.pageInset, width: widths.tasks - 2 * t.uiSpacing.sm,
        bottom: app.height - geometry.lineY }}>
        <PersistentSessionWeeklyUsage node={usageSummary.node} gauges={usageSummary.gauges}
          maxGaugeCount={usageSummary.maxGaugeCount} loading={usageSummary.loading} loadState={usageSummary.loadState}
          evaluatedAtMs={usageSummary.evaluatedAtMs} onRetry={usageSummary.retry}
          onNextNode={() => {
            if (!session?.node_id) return;
            const nextNodeId = nextUsageSummaryNodeId(usageSummary.summary, usageSummary.node?.nodeId ?? null);
            if (!nextNodeId) return;
            useSettingsStore.getState().setPersistentSessionWeeklyUsageNodeSelection(serverUrl, email,
              { configuredNodeId: session.node_id, selectedNodeId: nextNodeId });
          }} />
      </View> : null}
      <View ref={mainRef} testID="persistent-session-conversation" pointerEvents={phoneCardsScene ? 'none' : 'auto'}
        accessibilityElementsHidden={phoneCardsScene} importantForAccessibility={phoneCardsScene ? 'no-hide-descendants' : 'auto'}
        style={{ position: 'absolute', top: headerHeight, bottom: 0, left: columnLeft, width: columnWidth,
          opacity: hidePhoneConversation ? 0 : 1 }} onLayout={measureMain}>
        <ChatBody sessionId={session?.session_id} presentation="manuscript" showSessionAuxiliary={false}
          inputComposerRef={inputComposerRef} getReportSendContext={report.getSendContext}
          reportView={geometry?.reportBubble ? null : pager}
          active={chatActive} minimumBottomPadding={phone ? 0 : insets.bottom}
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
      {!phone && geometry?.reportBubble && report.entries.length > 0 ? <View testID="persistent-session-report-bubble-seat"
        style={{ position: 'absolute', left: geometry.reportBubble.left, bottom: (app?.height ?? 0) - geometry.reportBubble.bottom,
          width: geometry.reportBubble.width, maxHeight: geometry.reportBubble.maxHeight }}>
        {pager}
        <View testID="report-tail" pointerEvents="none" style={{ position: 'absolute',
          left: geometry.reportBubble.tailLeft - t.uiSpacing.lg / 2, bottom: -t.uiSpacing.lg / 2,
          width: t.uiSpacing.lg, height: t.uiSpacing.lg, backgroundColor: t.persistentSession.panel,
          borderRightWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: t.persistentSession.line,
          transform: [{ skewX: geometry.reportBubble.tailDirection === 'left' ? '-45deg' : '45deg' }, { rotate: '45deg' }] }} />
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
      {!phone ? <View style={{ position: 'absolute', top: headerHeight, right: t.foundation.pageInset - (t.hitTarget.min - t.foundation.iconFrame.compact) / 2 }}>
        {action('list-outline', scene === 'cards' ? 'PAS 대화로 돌아가기' : '카드 목록 보기', () => host.store.getState().toggleScene(), 'persistent-session-tasks')}
      </View> : null}
      {scene === 'cards' ? <View testID="persistent-session-card-panel" style={{ position: 'absolute',
        top: phone ? headerHeight : headerHeight + t.hitTarget.min,
        ...(phone ? { bottom: 0 } : { maxHeight: !phone && hasWeeklyUsage && geometry
          ? Math.max(0, geometry.lineY - usageHeight - t.spacing.xl - (headerHeight + t.hitTarget.min))
          : Math.max(0, (portrait && geometry ? geometry.lineY : app?.height ?? 0) - headerHeight - t.hitTarget.min - t.uiSpacing.md) }),
        right: phone ? 0 : t.foundation.pageInset - t.uiSpacing.sm,
        width: phone ? '100%' : widths.tasks,
        backgroundColor: t.persistentSession.paper,
        borderRadius: phone ? 0 : t.foundation.radius.card,
        borderWidth: 0, borderColor: t.persistentSession.line,
        paddingHorizontal: phone ? t.foundation.pageInset : t.uiSpacing.sm,
        paddingTop: phone ? t.uiSpacing.md : 0, paddingBottom: phone ? 0 : insets.bottom }}>
        <PersistentSessionTaskList api={api} visible={!selectedCardId}
          onOpenCard={cardId => phone && onOpenPhoneCard ? onOpenPhoneCard(cardId) : host.store.getState().selectCard(cardId)} />
      </View> : null}
      <PersistentSessionCardOverlay api={api} cardId={scene === 'cards' ? selectedCardId : null}
        sessionId={session?.session_id} bottomSafeAreaInset={insets.bottom}
        onClose={() => host.store.getState().selectCard(null)} />
      {settingsOpen && session ? <PersistentSessionPasSettingsModal sessionId={session.session_id} nodeId={session.node_id ?? ''}
        onClose={() => setSettingsOpen(false)} /> : null}
    </View>
  </SafeAreaView>;
}
