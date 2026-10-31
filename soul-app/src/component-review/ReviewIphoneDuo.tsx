import React, { useEffect, useMemo } from 'react';
import { DefaultTheme, NavigationContainer } from '@react-navigation/native';
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
import { PhoneRailTabCluster } from '../navigation/TabNavigator';
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

const PAS_LAYOUT_FRAMES = {
  'inner-landscape': { width: 951, height: 669, rail: false, insets: { top: 24, right: 84, bottom: 24, left: 0 } },
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
      action: '', options: [], state: 'open', answer: '', updated_at: '2026-10-29T00:00:00Z' }] as any;
    host.store.getState().open({
      session_id: sessionId, display_name: '영구 관제 세션', node_id: 'public-node',
      folder_id: null, agent_id: 'public-agent', agent_name: '로젤린', persistent: true,
      persistent_report: entries, settings: {},
      runtime: { current_model: { model_preset: null, reasoning_effort: null, model: null }, pending: null },
    } as any);
    useSessionStore.getState().applyPersistentReport(sessionId, entries);
    if (initialReportsScene && !reportsEmpty) host.store.getState().toggleReports();
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
              alignItems: 'center', justifyContent: 'flex-end', paddingBottom: Math.max(frame.insets.bottom, t.uiSpacing.xxl) }}>
              <DuoPasReviewRail duoSideBand={duoSideBand} />
            </View> : null}
          </View>
          <EntryShellAlertHarness />
          </NavigationContainer>
          </DuoSideBandContext.Provider>
        </PhoneRailModeContext.Provider>
      </SafeAreaInsetsContext.Provider>
    </SafeAreaFrameContext.Provider>
  </PersistentSessionProvider>;
}

function DuoPasReviewRail({ duoSideBand }: { duoSideBand: boolean }) {
  const host = usePersistentSessionHost();
  return <PhoneRailTabCluster active="PersistentTab" duoSideBand={duoSideBand}
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
                            paddingBottom: frame.insets.bottom,
                            alignItems: 'center',
                            justifyContent: 'flex-end',
                            borderLeftWidth: 1,
                            borderLeftColor: t.colors.border,
                          }}>
                            <PhoneRailTabCluster active={activeTab} onSelect={() => {}} duoSideBand={frame.insets.right >= RAIL_MIN_INSET_WIDTH && frame.insets.left === 0} />
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
