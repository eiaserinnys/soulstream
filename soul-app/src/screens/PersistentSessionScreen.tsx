import React, { useMemo, useState } from 'react';
import { Alert, BackHandler, PanResponder, StyleSheet, Text, View, useWindowDimensions, type LayoutRectangle } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import { calculatePersistentSessionLayout, type PersistentSessionRect } from '../../../packages/soul-ui/src/lib/persistent-session-layout';
import { createApiClient } from '../api/client';
import { ChatBody } from '../components/chat/ChatBody';
import { LiquidGlassButton } from '../components/LiquidGlassButton';
import { CardDetailContent } from '../components/planner/CardDetailSheet';
import { PersistentSessionTaskList } from '../components/persistent/PersistentSessionTaskList';
import { SwayCharacter } from '../components/persistent/SwayCharacter';
import { PERSISTENT_SESSION_FRAME as FRAME } from '../components/persistent/persistentSessionFrame';
import { PersistentSessionPasSettingsModal } from '../components/settings/PersistentSessionPasSettingsModal';
import { persistentChatDisplaySettings, savePersistentSessionSettings } from '../components/settings/persistentSessionSettingsActions';
import { useDisplayPreferenceActions } from '../components/settings/useDisplayPreferenceActions';
import { usePersistentSessionHost, usePersistentSessionScene } from '../navigation/PersistentSessionContext';
import { useChatStore } from '../store/chatStore';
import { useSettingsStore } from '../store/settingsStore';
import { createSessionVisualRoles, useDeviceType, useTokens } from '../theme';

export interface PersistentSessionScreenProps {
  active?: boolean;
  onHome(): void;
  onOpenCard(cardId: string): void;
  onOpenSession?(sessionId: string): void;
}

export function PersistentSessionScreen({ active = true, onHome, onOpenCard, onOpenSession }: PersistentSessionScreenProps) {
  const t = useTokens();
  const device = useDeviceType();
  const phone = device === 'phone';
  const { fontScale } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const host = usePersistentSessionHost();
  const session = usePersistentSessionScene(state => state.session);
  const scene = usePersistentSessionScene(state => state.scene);
  const selectedCardId = usePersistentSessionScene(state => state.selectedCardId);
  const serverUrl = useSettingsStore(state => state.serverUrl);
  const api = useMemo(() => serverUrl ? createApiClient(serverUrl) : null, [serverUrl]);
  const display = useChatStore(state => state.persistentDisplaySettings && state.persistentDisplaySettings.sessionId === session?.session_id
    ? state.persistentDisplaySettings.settings : null);
  const { handleAppearanceChange } = useDisplayPreferenceActions();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [savingCharacter, setSavingCharacter] = useState(false);
  const appRef = React.useRef<View>(null);
  const mainRef = React.useRef<View>(null);
  const [app, setApp] = useState<PersistentSessionRect | null>(null);
  const [main, setMain] = useState<PersistentSessionRect | null>(null);
  const [composer, setComposer] = useState<LayoutRectangle | null>(null);
  const compact = phone || (app?.height ?? Infinity) < FRAME.compactHeight;
  const headerHeight = compact ? FRAME.compactHeader : FRAME.header;
  const portrait = app ? app.height > app.width : false;
  const widths = portrait ? FRAME.portrait : FRAME.landscape;
  const columnWidth = phone ? Math.max(0, (app?.width ?? 0) - t.foundation.pageInset * 2) : widths.conversation;
  const columnLeft = app ? (app.width - columnWidth) / 2 : 0;
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
  const geometry = app && main && composer ? calculatePersistentSessionLayout({
    app,
    header: { left: app.left, top: app.top, width: app.width, height: headerHeight },
    main,
    baselineBottom: main.top + composer.y + composer.height,
    rowBottomGap: t.spacing.xs,
    inputRowHeight, pointerFine: false, showCharacter: display?.show_character === true,
    phoneConfigured: phone || compact,
  }) : null;
  const back = React.useCallback(() => {
    const state = host.store.getState();
    if (state.scene === 'cards') { state.swipe('right'); return true; }
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
  const action = (icon: React.ComponentProps<typeof Ionicons>['name'], label: string, onPress: () => void, testID: string) =>
    <LiquidGlassButton iconOnly variant="paper" size="compact" accessibilityLabel={label} onPress={onPress} testID={testID}>
      <Ionicons name={icon} size={t.iconSize.navigation} color={t.colors.textPrimary} />
    </LiquidGlassButton>;
  return <SafeAreaView testID="persistent-session-safe-area" edges={['top', 'left', 'right']}
    style={{ flex: 1, backgroundColor: t.persistentSession.paper }}>
    <View ref={appRef} testID="persistent-session-screen" style={{ flex: 1 }} onLayout={measureApp} {...(phone ? gestures.panHandlers : {})}>
      <View testID="persistent-session-header" style={{ height: headerHeight, flexDirection: 'row', alignItems: 'center',
        paddingLeft: t.foundation.pageInset, paddingRight: t.foundation.pageInset - (t.hitTarget.min - t.foundation.iconFrame.compact) / 2,
        gap: t.uiSpacing.sm }}>
        <Text numberOfLines={1} style={{ flex: 1, ...t.foundation.typography.navigation, color: t.colors.textPrimary }}>{session?.display_name ?? '영구 세션'}</Text>
        {action('home-outline', '홈으로 돌아가기', onHome, 'persistent-session-home')}
        {action(t.mode === 'light' ? 'moon-outline' : 'sunny-outline', '밝기 전환', () => void handleAppearanceChange(t.mode === 'light' ? 'dark' : 'light'), 'persistent-session-appearance')}
        {action('options-outline', '영구 세션 설정', () => setSettingsOpen(true), 'persistent-session-settings')}
        {phone ? action('list-outline', scene === 'cards' ? 'PAS 대화로 돌아가기' : '카드 목록 보기', () => host.store.getState().toggleScene(), 'persistent-session-tasks') : null}
      </View>
      <View ref={mainRef} testID="persistent-session-conversation" pointerEvents={phone && scene === 'cards' ? 'none' : 'auto'}
        accessibilityElementsHidden={phone && scene === 'cards'} importantForAccessibility={phone && scene === 'cards' ? 'no-hide-descendants' : 'auto'}
        style={{ position: 'absolute', top: headerHeight, bottom: 0, left: columnLeft, width: columnWidth,
          opacity: phone && scene === 'cards' ? 0 : 1 }} onLayout={measureMain}>
        <ChatBody sessionId={session?.session_id} presentation="manuscript"
          active={active && scene === 'conversation'} minimumBottomPadding={phone ? 0 : insets.bottom}
          onComposerLayout={event => {
            const layout = event.nativeEvent.layout;
            if (layout.width > 0 && layout.height > 0) setComposer(layout);
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
      {!phone && geometry?.toggle ? <View testID="persistent-session-character-toggle-seat" style={{ position: 'absolute',
        left: geometry.toggle.left + (geometry.toggle.width - t.hitTarget.min) / 2,
        top: geometry.lineY + (inputRowHeight - t.hitTarget.min) / 2 }}>
        <LiquidGlassButton iconOnly size="compact" variant="paper" disabled={savingCharacter} testID="persistent-session-character-toggle"
          accessibilityLabel={display?.show_character ? '캐릭터 숨기기' : '캐릭터 표시'}
          accessibilityState={{ selected: display?.show_character === true }} onPress={() => void toggleCharacter()}>
          <Ionicons testID="persistent-session-character-toggle-icon" name={display?.show_character ? 'person' : 'person-outline'}
            size={t.iconSize.navigation} color={display?.show_character ? t.colors.textPrimary : t.colors.textMuted} />
        </LiquidGlassButton>
      </View> : null}
      {!phone ? <View style={{ position: 'absolute', top: headerHeight, right: t.foundation.pageInset - (t.hitTarget.min - t.foundation.iconFrame.compact) / 2 }}>
        {action('list-outline', scene === 'cards' ? 'PAS 대화로 돌아가기' : '카드 목록 보기', () => host.store.getState().toggleScene(), 'persistent-session-tasks')}
      </View> : null}
      {scene === 'cards' ? <View testID="persistent-session-card-panel" style={{ position: 'absolute',
        top: headerHeight + (phone ? 0 : t.hitTarget.min),
        ...(phone ? { bottom: 0 } : { maxHeight: Math.max(0, (portrait && geometry ? geometry.lineY : app?.height ?? 0) - headerHeight - t.hitTarget.min - t.uiSpacing.md) }),
        right: phone ? 0 : !selectedCardId ? t.foundation.pageInset - t.uiSpacing.sm : portrait ? t.foundation.pageInset : app ? app.width - columnLeft - columnWidth - t.uiSpacing.xl - (selectedCardId ? widths.detail : widths.tasks) : t.foundation.pageInset,
        width: phone ? '100%' : selectedCardId ? widths.detail : widths.tasks,
        backgroundColor: selectedCardId && !phone ? t.persistentSession.panel : t.persistentSession.paper,
        borderRadius: phone ? 0 : t.foundation.radius.card,
        borderWidth: selectedCardId && !phone ? StyleSheet.hairlineWidth : 0, borderColor: t.persistentSession.line,
        paddingHorizontal: selectedCardId ? 0 : phone ? t.foundation.pageInset : t.uiSpacing.sm,
        paddingTop: phone && !selectedCardId ? t.uiSpacing.md : 0, paddingBottom: phone ? 0 : insets.bottom }}>
        <PersistentSessionTaskList api={api} visible={!selectedCardId}
          onOpenCard={cardId => host.store.getState().selectCard(cardId)} />
        {selectedCardId ? <>
          <View testID="persistent-summary-header" style={{ paddingHorizontal: t.foundation.pageInset - (t.hitTarget.min - t.foundation.iconFrame.compact) / 2, alignItems: 'flex-start' }}>
            <LiquidGlassButton iconOnly size="compact" variant="paper" accessibilityLabel="목록으로" testID="persistent-summary-back"
              onPress={() => host.store.getState().selectCard(null)}>
              <Ionicons name="chevron-back" size={t.iconSize.navigation} color={t.colors.textPrimary} />
            </LiquidGlassButton>
          </View>
          <CardDetailContent key={selectedCardId} variant="readSummary" fitContent={!phone} api={api} cardId={selectedCardId}
          onClose={() => host.store.getState().selectCard(null)} onOpenCard={() => onOpenCard(selectedCardId)} onOpenSession={onOpenSession} />
          </>
          : null}
      </View> : null}
      {settingsOpen && session ? <PersistentSessionPasSettingsModal sessionId={session.session_id} nodeId={session.node_id ?? ''}
        onClose={() => setSettingsOpen(false)} /> : null}
    </View>
  </SafeAreaView>;
}
