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
import { PhoneRailModeContext } from '../navigation/tabContract';
import { ContentLinkProvider } from '../navigation/ContentLinkProvider';
import { PhoneRailTabCluster } from '../navigation/TabNavigator';
import { PersistentSessionProvider } from '../navigation/PersistentSessionContext';
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
import { ReviewEntryShell } from './ReviewEntryShell';
import { ReviewPersistentCardOverlay } from './ReviewPersistentCardOverlay';

const RAIL_WIDTH = 84;

export const IPHONE_DUO_FRAMES = [
  { id: 'outer-portrait', label: '바깥 세로', width: 466, height: 678, rail: true, insets: { top: 24, right: 84, bottom: 24, left: 0 } },
  { id: 'outer-landscape', label: '바깥 가로', width: 678, height: 466, rail: true, insets: { top: 24, right: 84, bottom: 24, left: 0 } },
  { id: 'inner-portrait', label: '안쪽 세로', width: 669, height: 951, rail: false, insets: { top: 72, right: 0, bottom: 24, left: 0 } },
  { id: 'inner-portrait-short', label: '안쪽 세로(높이 890)', width: 626, height: 890, rail: false, insets: { top: 72, right: 0, bottom: 24, left: 0 } },
  { id: 'inner-landscape', label: '안쪽 가로', width: 951, height: 669, rail: false, insets: { top: 24, right: 84, bottom: 24, left: 0 } },
  { id: 'inner-landscape-short', label: '안쪽 가로(높이 626)', width: 890, height: 626, rail: false, insets: { top: 24, right: 84, bottom: 24, left: 0 } },
] as const;

export function ReviewIphoneDuo() {
  const t = useTokens();
  const api = useMemo(() => createReviewApi('normal', { entryShell: true }), []);
  const sample = typeof window !== 'undefined'
    ? new URLSearchParams(window.location.search).get('sample')
    : null;
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
                        : <ReviewPersistentCardOverlay />;
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
                          <SafeAreaInsetsContext.Provider value={frame.rail ? { ...frameInsets, right: 0 } : frameInsets}>
                            <View style={{ width: safeWidth, height: '100%', minWidth: 0, minHeight: 0 }}>
                              {frame.id === 'inner-landscape-short'
                                ? mainContent
                                : <NavigationContainer theme={navigationTheme}>{mainContent}</NavigationContainer>}
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
                            <PhoneRailTabCluster active={activeTab} onSelect={() => {}} />
                          </View> : frame.insets.right > 0 ? <View style={{ width: frame.insets.right }} /> : null}
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
