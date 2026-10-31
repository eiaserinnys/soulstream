import React, { useEffect, useMemo, useState } from 'react';
import { DefaultTheme, NavigationContainer, useNavigationContainerRef } from '@react-navigation/native';
import { ScrollView, Text, View } from 'react-native';
import {
  SafeAreaFrameContext,
  SafeAreaInsetsContext,
  type EdgeInsets,
  type Rect,
} from 'react-native-safe-area-context';
import { useTokens } from '../theme';
import { SessionFeedScreen } from '../screens/SessionFeedScreen';
import { SettingsScreen } from '../screens/SettingsScreen';
import { DuoSideBandContext, PhoneRailModeContext, RAIL_MIN_INSET_WIDTH } from '../navigation/tabContract';
import { ContentLinkProvider } from '../navigation/ContentLinkProvider';
import { PhoneRailTabCluster, TabNavigator } from '../navigation/TabNavigator';
import { DUO_RAIL_END_INSET } from '../navigation/duoSideBand';
import { TwoPaneWithDrawer } from '../components/split/TwoPaneWithDrawer';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { PersistentSessionProvider, usePersistentSessionHost, usePersistentSessionScene } from '../navigation/PersistentSessionContext';
import { PersistentSessionScreen } from '../screens/PersistentSessionScreen';
import { LiquidGlassButton } from '../components/LiquidGlassButton';
import {
  CardConversationPane,
  FolderWorkspaceDetailPane,
  FolderWorkspaceSinglePanel,
} from '../components/planner/FolderWorkspaceReadOverlay';
import { MainListPane } from '../components/split/MainListPane';
import { TabletSessionFeedPane } from '../components/split/TabletSessionFeedPane';
import { calculateTwoPaneWidths } from '../components/split/paneWidths';
import { getFolderWorkspaceOverlayWidth } from '../lib/folder-workspace-layout';
import { createReviewApi, entryShellCardId } from './fixtures';
import { installEntryShellPublicHarness } from './fixture-client';
import { EntryShellAlertHarness, ReviewEntryShell } from './ReviewEntryShell';
import { ReviewPersistentCardOverlay } from './ReviewPersistentCardOverlay';
import { useChatStore } from '../store/chatStore';
import { useSessionStore } from '../store/sessionStore';
import { useUIStore } from '../store/uiStore';
import { CardDetailContent } from '../components/planner/CardDetailSheet';
import { FolderWorkspace } from '../components/planner/FolderWorkspace';
import { DuoRailOverride } from '../components/navigation/DuoRailOverride';
import { useRegisterDuoRailOverride } from '../navigation/phoneRailActions';

const PAS_LAYOUT_FRAMES = {
  'inner-landscape': { width: 951, height: 669, rail: false, insets: { top: 24, right: 84, bottom: 24, left: 0 } },
  'inner-landscape-short': { width: 890, height: 626, rail: false, insets: { top: 24, right: 84, bottom: 24, left: 0 } },
  'inner-portrait': { width: 669, height: 951, rail: false, insets: { top: 72, right: 0, bottom: 24, left: 0 } },
  'ipad-pro-13-portrait': { width: 1032, height: 1376, rail: false, insets: { top: 24, right: 0, bottom: 20, left: 0 } },
  'ipad-pro-13-landscape': { width: 1376, height: 1032, rail: false, insets: { top: 24, right: 0, bottom: 20, left: 0 } },
  'outer-portrait': { width: 466, height: 678, rail: true, insets: { top: 24, right: 84, bottom: 24, left: 0 } },
  'outer-landscape': { width: 678, height: 466, rail: true, insets: { top: 24, right: 84, bottom: 24, left: 0 } },
  'iphone-17': { width: 393, height: 852, rail: false, insets: { top: 59, right: 0, bottom: 34, left: 0 } },
  'iphone-17-landscape': { width: 852, height: 393, rail: true, insets: { top: 0, right: 59, bottom: 21, left: 59 } },
} as const;

const RAIL_WIDTH = 84;

export const IPHONE_DUO_FRAMES = [
  { id: 'outer-portrait', label: '바깥 세로', width: 466, height: 678, rail: true, insets: { top: 24, right: 84, bottom: 24, left: 0 } },
  { id: 'outer-landscape', label: '바깥 가로', width: 678, height: 466, rail: true, insets: { top: 24, right: 84, bottom: 24, left: 0 } },
  { id: 'inner-portrait', label: '안쪽 세로', width: 669, height: 951, rail: false, insets: { top: 72, right: 0, bottom: 24, left: 0 } },
  { id: 'inner-portrait-short', label: '안쪽 세로(높이 890)', width: 626, height: 890, rail: false, insets: { top: 72, right: 0, bottom: 24, left: 0 } },
  { id: 'inner-landscape', label: '안쪽 가로', width: 951, height: 669, rail: false, insets: { top: 24, right: 84, bottom: 24, left: 0 } },
  { id: 'inner-landscape-short', label: '안쪽 가로(높이 626)', width: 890, height: 626, rail: false, insets: { top: 24, right: 84, bottom: 24, left: 0 } },
] as const;

const MainReviewStack = createNativeStackNavigator();

function DuoBadgeReview({ dot }: { dot: boolean }) {
  useRegisterDuoRailOverride('review-badge', true, [
    { id: 'badge-preview', label: '확인 항목', icon: 'checkbox-outline', badgeCount: dot ? undefined : 3, dot, onPress: () => {} },
  ]);
  return <View style={{ flex: 1 }} />;
}

function DuoMainLayoutReview({ frameId }: { frameId: keyof typeof PAS_LAYOUT_FRAMES }) {
  const frame = PAS_LAYOUT_FRAMES[frameId];
  const params = new URLSearchParams(window.location.search);
  const duo = params.get('band') !== 'off' && frame.insets.right >= RAIL_MIN_INSET_WIDTH && frame.insets.left === 0;
  const phone = frameId.startsWith('outer-') || frameId.startsWith('iphone-');
  const initialTab = params.get('tab') ?? undefined;
  const sampleCardId = params.get('card') ?? entryShellCardId;
  const [view, setView] = useState(params.get('view'));
  const navigationRef = useNavigationContainerRef<any>();
  const phoneChat = phone && view === 'chat';
  const api = useMemo(() => createReviewApi('normal', { entryShell: true }), []);
  useEffect(() => installEntryShellPublicHarness(), []);
  return <PersistentSessionProvider><ContentLinkProvider>
    <SafeAreaFrameContext.Provider value={{ x: 0, y: 0, width: frame.width, height: frame.height }}>
      <SafeAreaInsetsContext.Provider value={frame.insets}>
        <DuoSideBandContext.Provider value={duo}>
          <NavigationContainer ref={navigationRef} onReady={() => {
            if (phoneChat) navigationRef.navigate('FeedTab', { screen: 'Chat', params: { sessionId: 'public-shell-session-0' } });
            if (!phone && params.get('overlay') === 'card-with-chat') useUIStore.getState().openCardOverlay(sampleCardId, 'public-shell-session-0');
          }}>
            <View style={{ width: frame.width, height: frame.height, overflow: 'hidden' }}>
              {view && !phoneChat ? <View style={{ flex: 1, flexDirection: 'row' }}>
                <SafeAreaInsetsContext.Provider value={{ ...frame.insets, right: 0 }}>
                  <View style={{ flex: 1, paddingTop: frame.insets.top, paddingBottom: frame.insets.bottom }}>
                    {view === 'card-detail' ? <CardDetailContent api={api} cardId={sampleCardId} inline={!phone} onClose={() => setView(null)} /> : null}
                    {view === 'folder-workspace' ? <FolderWorkspace api={api} folderPageId="public-shell-page-0" active onClose={() => setView(null)} onOpenSession={() => setView('chat')} /> : null}
                    {view === 'chat' ? <FolderWorkspaceSinglePanel api={api} cardId={entryShellCardId} pageId={null} sessionId="public-shell-session-0" active initialStep="chat" onClose={() => setView(null)} /> : null}
                    {view === 'rail-badge' || view === 'rail-dot' ? <DuoBadgeReview dot={view === 'rail-dot'} /> : null}
                  </View>
                </SafeAreaInsetsContext.Provider>
                {phone ? <View style={{ width: frame.insets.right, alignItems: 'center', justifyContent: 'flex-end', paddingBottom: frame.insets.bottom, ...(duo ? { paddingRight: DUO_RAIL_END_INSET } : {}) }}>
                  <PhoneRailTabCluster active="DailyTab" duoSideBand={duo} compact={duo && frame.width > frame.height} onSelect={() => setView(null)} />
                </View> : null}
                {!phone && duo ? <View style={{ width: frame.insets.right }} /> : null}
                {!phone && duo ? <DuoRailOverride /> : null}
              </View> : phone ? <TabNavigator initialTab={phoneChat ? 'FeedTab' : initialTab} /> : <MainReviewStack.Navigator screenOptions={{ headerShown: false }}>
                <MainReviewStack.Screen name="Main" component={TwoPaneWithDrawer} />
                <MainReviewStack.Screen name="PersistentSession" component={DuoPasCardOverlayStage} />
              </MainReviewStack.Navigator>}
            </View>
            <EntryShellAlertHarness />
          </NavigationContainer>
        </DuoSideBandContext.Provider>
      </SafeAreaInsetsContext.Provider>
    </SafeAreaFrameContext.Provider>
  </ContentLinkProvider></PersistentSessionProvider>;
}

function DuoPasCardOverlayStage({ reportsEmpty = false, initialReportsScene = false }: { reportsEmpty?: boolean; initialReportsScene?: boolean }) {
  const host = usePersistentSessionHost();
  const visible = usePersistentSessionScene(state => state.visible);
  const session = usePersistentSessionScene(state => state.session);
  const t = useTokens();
  useEffect(() => {
    const sessionId = 'review-pas-1';
    const entries = reportsEmpty ? [] : [{ key: 'card_804', kind: 'see', title: '지금의 보고 · #804', card_numbers: [804],
      card_id: 'preview-pas-card', card_status: 'review', context: '검수용 카드 장입니다.', action: '',
      options: [], state: 'open', answer: '', updated_at: '2026-10-29T00:00:00Z' },
    { key: 'report_805', kind: 'see', title: '두 번째 보고', card_numbers: [805], context: '두 번째 보고입니다.',
      action: '', options: [], state: 'open', answer: '', updated_at: '2026-10-29T00:00:00Z' },
    { key: 'ask_806', kind: 'ask', title: '세 번째 보고 · 배포 확인', card_numbers: [806],
      context: '세로 스크롤에서 여러 보고 카드를 한눈에 확인합니다.', action: '배포 시점을 골라 주세요.',
      options: ['지금 배포', '내일 오전'], state: 'open', answer: '', updated_at: '2026-10-29T00:00:00Z' }] as any;
    host.store.getState().open({
      session_id: sessionId, display_name: '영구 관제 세션', node_id: 'public-node',
      folder_id: null, agent_id: 'public-agent', agent_name: '로젤린', persistent: true,
      persistent_report: entries, settings: {},
      runtime: { current_model: { model_preset: null, reasoning_effort: null, model: null }, pending: null },
    } as any);
    useSessionStore.getState().applyPersistentReport(sessionId, entries);
    if (initialReportsScene && !reportsEmpty) host.store.getState().toggleReports();
    if (new URLSearchParams(window.location.search).get('view') === 'card-detail') {
      host.store.getState().selectCard('preview-pas-card');
    }
    const request = useChatStore.getState().beginPersistentDisplaySettingsLoad(sessionId);
    useChatStore.getState().finishPersistentDisplaySettingsLoad(sessionId, request, {
      show_character: true, animate_character: false, show_generation_separator: true,
      show_jev_candidates: true, turn_usage_mode: 'collapsed',
    });
  }, [host.store, reportsEmpty, initialReportsScene]);
  return visible ? <PersistentSessionScreen active onHome={() => host.store.getState().leave()} />
    : session ? <View testID="review-pas-home" style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
      <LiquidGlassButton accessibilityLabel="PAS 다시 열기" onPress={() => host.store.getState().open(session)}>
        <Text style={{ ...t.foundation.typography.body, color: t.colors.textPrimary }}>PAS 다시 열기</Text>
      </LiquidGlassButton>
    </View> : null;
}

function DuoPasLayoutReview({ frameId, reportsEmpty, initialReportsScene }: { frameId: keyof typeof PAS_LAYOUT_FRAMES; reportsEmpty: boolean; initialReportsScene: boolean }) {
  const t = useTokens();
  const frame = PAS_LAYOUT_FRAMES[frameId];
  const frameRect: Rect = { x: 0, y: 0, width: frame.width, height: frame.height };
  const duoSideBand = frame.insets.right >= RAIL_MIN_INSET_WIDTH && frame.insets.left === 0;
  const compact = duoSideBand && frame.width > frame.height;
  return <PersistentSessionProvider>
    <SafeAreaFrameContext.Provider value={frameRect}>
      <SafeAreaInsetsContext.Provider value={frame.insets}>
        <PhoneRailModeContext.Provider value={frame.rail}>
          <DuoSideBandContext.Provider value={duoSideBand}>
          <NavigationContainer>
          <View style={{ flex: 1, flexDirection: 'row', width: frame.width, height: frame.height, overflow: 'hidden' }}>
            <SafeAreaInsetsContext.Provider value={frame.rail ? { ...frame.insets, right: 0 } : frame.insets}>
              <View style={{ width: frame.rail ? frame.width - frame.insets.right : frame.width, height: frame.height }}><DuoPasCardOverlayStage reportsEmpty={reportsEmpty} initialReportsScene={initialReportsScene} /></View>
            </SafeAreaInsetsContext.Provider>
            {frame.rail && frame.insets.right > 0 ? <View style={{ width: frame.insets.right, height: frame.height,
              alignItems: 'center', justifyContent: 'flex-end', paddingBottom: compact ? frame.insets.bottom : Math.max(frame.insets.bottom, t.uiSpacing.xxl),
              ...(duoSideBand ? { paddingRight: DUO_RAIL_END_INSET } : {}) }}>
              <DuoPasReviewRail duoSideBand={duoSideBand} compact={compact} />
            </View> : null}
            {!frame.rail && duoSideBand ? <View style={{ width: frame.insets.right, height: frame.height }} /> : null}
            {!frame.rail && duoSideBand ? <DuoRailOverride /> : null}
          </View>
          <EntryShellAlertHarness />
          </NavigationContainer>
          </DuoSideBandContext.Provider>
        </PhoneRailModeContext.Provider>
      </SafeAreaInsetsContext.Provider>
    </SafeAreaFrameContext.Provider>
  </PersistentSessionProvider>;
}

function DuoPasReviewRail({ duoSideBand, compact }: { duoSideBand: boolean; compact: boolean }) {
  const host = usePersistentSessionHost();
  return <PhoneRailTabCluster active="PersistentTab" duoSideBand={duoSideBand} compact={compact}
    onSelect={() => host.store.getState().toggleScene()} />;
}

export function ReviewIphoneDuo() {
  const t = useTokens();
  const api = useMemo(() => createReviewApi('normal', { entryShell: true }), []);
  const sample = typeof window !== 'undefined'
    ? new URLSearchParams(window.location.search).get('sample')
    : null;
  if (sample === 'pas-layout') {
    const frameId = new URLSearchParams(window.location.search).get('frame') as keyof typeof PAS_LAYOUT_FRAMES | null;
    if (!frameId || !PAS_LAYOUT_FRAMES[frameId]) return null;
    return <DuoPasLayoutReview frameId={frameId} reportsEmpty={new URLSearchParams(window.location.search).get('reports') === '0'}
      initialReportsScene={new URLSearchParams(window.location.search).get('scene') === 'reports'} />;
  }
  if (sample === 'main-layout') {
    const frameId = new URLSearchParams(window.location.search).get('frame') as keyof typeof PAS_LAYOUT_FRAMES | null;
    if (!frameId || !PAS_LAYOUT_FRAMES[frameId]) return null;
    return <DuoMainLayoutReview frameId={frameId} />;
  }
  const navigationTheme = {
    ...DefaultTheme,
    colors: { ...DefaultTheme.colors, background: t.colors.background },
  };

  useEffect(() => sample === 'entry' ? undefined : installEntryShellPublicHarness(), [sample]);

  if (sample === 'entry') return <ReviewEntryShell />;
  if (sample === 'settings') return <SettingsScreen showTitle={false} bottomSafeAreaOwner="parent" />;
  if (sample === 'pas') return <ContentLinkProvider><ReviewPersistentCardOverlay /></ContentLinkProvider>;

  return (
    <PersistentSessionProvider>
      <ContentLinkProvider>
        <View testID="review-iphone-duo" style={{ flex: 1, backgroundColor: t.colors.background }}>
          <ScrollView horizontal contentContainerStyle={{ padding: t.spacing.lg, gap: t.spacing.lg }}>
            {IPHONE_DUO_FRAMES.map((frame) => {
              const safeWidth = frame.width - frame.insets.left - frame.insets.right;
              const safeHeight = frame.height - frame.insets.top - frame.insets.bottom;
              const twoPane = calculateTwoPaneWidths(
                Math.max(0, safeWidth - 2 * t.tabletShell.outerInset),
              );
              const overlayWidth = getFolderWorkspaceOverlayWidth(safeWidth);
              const frameRect: Rect = { x: 0, y: 0, width: frame.width, height: frame.height };
              const frameInsets: EdgeInsets = frame.insets;
              const mainContent = frame.id === 'outer-portrait'
                ? <SessionFeedScreen active reserveBottomSearchBarSpace onOpenSession={() => {}} />
                : frame.id === 'outer-landscape'
                  ? <SettingsScreen showTitle={false} bottomSafeAreaOwner="parent" />
                  : frame.id === 'inner-portrait'
                    ? <View style={{ flex: 1, minWidth: 0, flexDirection: 'row', gap: t.tabletShell.panelGap, paddingHorizontal: t.tabletShell.outerInset }}>
                      <View style={{ width: twoPane.middle, minWidth: 0 }}>
                        <MainListPane paneWidth={twoPane.middle} />
                      </View>
                      <TabletSessionFeedPane width={twoPane.right} onOpenSession={() => {}} />
                    </View>
                    : frame.id === 'inner-portrait-short'
                      ? <View style={{ width: overlayWidth, height: safeHeight, minHeight: 0 }}>
                        <FolderWorkspaceSinglePanel
                          api={api}
                          cardId={entryShellCardId}
                          pageId="public-shell-page-0"
                          sessionId="public-shell-session-0"
                          overlayWidth={overlayWidth}
                          active
                          onClose={() => {}}
                        />
                      </View>
                      : frame.id === 'inner-landscape'
                        ? <View style={{ width: overlayWidth, height: safeHeight, minHeight: 0, flexDirection: 'row', overflow: 'hidden' }}>
                          <FolderWorkspaceDetailPane
                            api={api}
                            cardId={entryShellCardId}
                            pageId="public-shell-page-0"
                            sessionId="public-shell-session-0"
                            active
                            width={Math.round(overlayWidth * 0.5)}
                            onClose={() => {}}
                          />
                          <CardConversationPane active sessionId="public-shell-session-0" />
                        </View>
                        : <PersistentSessionProvider><DuoPasCardOverlayStage /></PersistentSessionProvider>;
              const activeTab = frame.id === 'outer-portrait' ? 'FeedTab' : 'SettingsTab';
              const duoSideBand = frame.insets.right >= RAIL_MIN_INSET_WIDTH && frame.insets.left === 0;
              const compact = duoSideBand && frame.width > frame.height;
              return (
                <View key={frame.id} style={{ gap: t.spacing.sm }}>
                  <Text style={{ ...t.foundation.typography.meta, color: t.colors.textMuted }}>{frame.label}</Text>
                  <View
                    testID={`iphone-duo-stage-${frame.id}`}
                    style={{
                      width: frame.width,
                      height: frame.height,
                      flexDirection: 'row',
                      borderRadius: t.foundation.radius.panel,
                      borderWidth: 1,
                      borderColor: t.colors.border,
                      backgroundColor: t.colors.background,
                      overflow: 'hidden',
                    }}
                  >
                    <SafeAreaFrameContext.Provider value={frameRect}>
                      <SafeAreaInsetsContext.Provider value={frameInsets}>
                        <PhoneRailModeContext.Provider value={frame.rail}>
                        <DuoSideBandContext.Provider value={frame.insets.right >= RAIL_MIN_INSET_WIDTH && frame.insets.left === 0}>
                        <NavigationContainer theme={navigationTheme}>
                          <SafeAreaInsetsContext.Provider value={{ ...frameInsets, right: 0 }}>
                            <View style={{ width: safeWidth, height: '100%', minWidth: 0, minHeight: 0 }}>
                              {mainContent}
                            </View>
                          </SafeAreaInsetsContext.Provider>
                          {frame.rail ? <View style={{
                            width: RAIL_WIDTH,
                            paddingBottom: compact ? frame.insets.bottom : Math.max(frame.insets.bottom, t.uiSpacing.xxl),
                            alignItems: 'center',
                            justifyContent: 'flex-end',
                            ...(duoSideBand ? { paddingRight: DUO_RAIL_END_INSET } : {}),
                            borderLeftWidth: 1,
                            borderLeftColor: t.colors.border,
                          }}>
                            <PhoneRailTabCluster active={activeTab} onSelect={() => {}} duoSideBand={duoSideBand} compact={compact} />
                          </View> : frame.insets.right > 0 ? <View style={{ width: frame.insets.right }} /> : null}
                        </NavigationContainer>
                        </DuoSideBandContext.Provider>
                        </PhoneRailModeContext.Provider>
                      </SafeAreaInsetsContext.Provider>
                    </SafeAreaFrameContext.Provider>
                  </View>
                </View>
              );
            })}
          </ScrollView>
        </View>
      </ContentLinkProvider>
    </PersistentSessionProvider>
  );
}
