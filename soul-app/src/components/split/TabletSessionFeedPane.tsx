import React, { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { openPlannerSessionWorkspace } from '../../lib/planner-folder-workspace';
import { openFeedSessionCardWorkspace } from '../../lib/session-feed-card-workspace';
import { SessionFeedScreen } from '../../screens/SessionFeedScreen';
import { useTokens, type DesignTokens } from '../../theme';
import { RootSectionHeaderTitle } from '../navigation/RootSectionHeaderTitle';
import { TabletPaneHeader } from './TabletPaneHeader';
import { SearchScreen } from '../../screens/SearchScreen';
import { useSearchStore } from '../../store/searchStore';
import { useUIStore } from '../../store/uiStore';
import { LiquidGlassButton } from '../LiquidGlassButton';
import Ionicons from '@expo/vector-icons/Ionicons';
import { recordUiUsageEvent } from '../../lib/ui-usage-events';

/**
 * 태블릿 portrait·landscape가 공유하는 session feed chrome 구현.
 * 새 화면이 아니라 기존 두 adaptive surface의 header와 feed 진입 경계를 한 곳에서 소유한다.
 */
export function TabletSessionFeedPane({ width, onOpenSession }: {
  width?: number;
  onOpenSession?: (sessionId: string) => void;
} = {}) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);
  const searchActive = useSearchStore((state) => state.tabletActive);
  const folderOverlayVisible = useUIStore((state) => state.folderOverlayVisible);

  return (
    <View style={[styles.container, width === undefined ? null : { width }]}>
      <TabletPaneHeader testID="tablet-feed-header">
        <View testID="tablet-feed-title" style={styles.title}>
          <RootSectionHeaderTitle
            section="FeedTab"
            title={searchActive ? '검색' : undefined}
          />
        </View>
        {searchActive ? (
          <LiquidGlassButton
            iconOnly
            accessibilityLabel="검색 닫기"
            onPress={useSearchStore.getState().closeTabletSearch}
            contentStyle={styles.closeAction}
          >
            <Ionicons
              name="close"
              color={t.colors.textPrimary}
              size={t.iconSize.standard}
            />
          </LiquidGlassButton>
        ) : null}
      </TabletPaneHeader>
      <View style={styles.body}>
        {searchActive ? (
          <SearchScreen
            tablet
            showInput={false}
            autoFocus={false}
            onOpenSession={(sessionId, eventId, storyOpenRequestId) =>
              openPlannerSessionWorkspace(
                sessionId,
                eventId,
                storyOpenRequestId,
                'search',
              )
            }
            onOpenFolder={(result) => {
              recordUiUsageEvent({
                type: 'view_open',
                target: { kind: 'folder', id: result.folderId },
                from: { kind: 'view', id: 'search' },
                entry: 'search',
              });
              useUIStore.getState().setActiveSection({
                kind: 'project',
                folderId: result.folderId,
                projectPageId: result.projectPageId,
              });
              useSearchStore.getState().closeTabletSearch();
            }}
          />
        ) : (
          <SessionFeedScreen
            active={!folderOverlayVisible}
            reserveHomeComposerSpace
            onOpenSession={onOpenSession ?? ((sessionId) => openFeedSessionCardWorkspace(sessionId))}
          />
        )}
      </View>
    </View>
  );
}

function makeStyles(t: DesignTokens) {
  return StyleSheet.create({
    container: { flex: 1, minWidth: 0, minHeight: 0 },
    title: { flexShrink: 1 },
    body: { flex: 1 },
    closeAction: {
      minWidth: t.hitTarget.min,
      minHeight: t.hitTarget.min,
      alignItems: 'center',
      justifyContent: 'center',
    },
  });
}
