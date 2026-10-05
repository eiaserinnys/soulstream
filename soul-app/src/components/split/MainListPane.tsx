import React, { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  DailyPlannerScreen,
  type DailyPlannerScreenHandle,
} from '../../screens/DailyPlannerScreen';
import { FolderWorkspace } from '../planner/FolderWorkspace';
import { createApiClient } from '../../api/client';
import { useSettingsStore } from '../../store/settingsStore';
import { openPlannerFolderWorkspace } from '../../lib/planner-folder-workspace';
import { useSessionStore } from '../../store/sessionStore';
import { useUIStore } from '../../store/uiStore';
import { useTokens, type DesignTokens } from '../../theme';
import { LiquidGlassButton } from '../LiquidGlassButton';
import { RootSectionHeaderTitle } from '../navigation/RootSectionHeaderTitle';
import { DailyHeaderActions } from '../planner/DailyHeaderActions';
import { TabletPaneHeader } from './TabletPaneHeader';
import { SessionSearchField } from '../search/SessionSearchField';
import { useSearchStore } from '../../store/searchStore';
import { recordUiUsageEvent } from '../../lib/ui-usage-events';
import { SettingsSegmentedControl } from '../settings/SettingsSegmentedControl';
import { CardBoardWorkspace, type CardBoardWorkspaceHandle } from '../planner/CardBoardWorkspace';
import { CompletedCardsToggle } from '../planner/CompletedCardsToggle';
import { useAuthScopeGeneration } from '../../lib/auth-scope';
import { useCardDisplay } from '../../hooks/useCardDisplay';

export function MainListPane({
  onMenuPress,
  topInsetPadding = false,
  showSearch = false,
}: {
  onMenuPress?: () => void;
  topInsetPadding?: boolean;
  showSearch?: boolean;
}) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);
  const dailyRef = useRef<DailyPlannerScreenHandle>(null);
  const boardRef = useRef<CardBoardWorkspaceHandle>(null);
  const insets = useSafeAreaInsets();
  const activeSection = useUIStore((state) => state.activeSection);
  const effectiveShowSearch = showSearch && activeSection.kind !== 'daily';
  const views = useUIStore(state => state.mainPaneViews);
  const setMainPaneView = useUIStore(state => state.setMainPaneView);
  const scope = useAuthScopeGeneration();
  const displayOwner = `${scope}:${activeSection.kind === 'project' ? activeSection.folderId : 'global'}`;
  const viewKey = activeSection.kind === 'project' ? activeSection.folderId : 'global';
  const view = activeSection.kind === 'daily' ? 'board' : views[viewKey] ?? 'existing';
  const [visited, setVisited] = useState<Record<string, boolean>>(() => ({
    global: true,
    ...Object.fromEntries(Object.entries(views).filter(([, view]) => view === 'board').map(([key]) => [key, true])),
  }));
  const setView = (value: 'existing' | 'board') => { setMainPaneView(viewKey, value); if (value === 'board') setVisited((old) => ({ ...old, [viewKey]: true })); };
  const cardDisplay = useCardDisplay(activeSection.kind === 'project' ? activeSection.folderId : undefined);
  const setActiveSection = useUIStore((state) => state.setActiveSection);
  const folders = useSessionStore((state) => state.catalog.folders);
  const serverUrl = useSettingsStore((state) => state.serverUrl);
  const api = useMemo(() => serverUrl ? createApiClient(serverUrl) : null, [serverUrl]);
  const searchQuery = useSearchStore((state) => state.query);
  const searchFocusRequestId = useSearchStore((state) => state.focusRequestId);
  const searchInputRef = useRef<TextInput>(null);
  const title = activeSection.kind === 'daily'
    ? view === 'board' ? '카드' : '데일리 기록'
    : folders.find((folder) => folder.id === activeSection.folderId)?.name ?? '프로젝트';
  useEffect(() => {
    if (effectiveShowSearch && searchFocusRequestId > 0) {
      requestAnimationFrame(() => searchInputRef.current?.focus());
    }
  }, [searchFocusRequestId, effectiveShowSearch]);
  return (
    <View style={styles.container}>
      <TabletPaneHeader
        testID="tablet-main-header"
        style={topInsetPadding && {
          paddingTop: t.tabletShell.header.paddingVertical + insets.top,
          minHeight: t.tabletShell.header.minHeight + insets.top,
        }}
      >
        {onMenuPress ? (
          <LiquidGlassButton
            iconOnly
            onPress={onMenuPress}
            accessibilityLabel="메뉴"
            contentStyle={styles.headerAction}
          >
            <Ionicons name="menu" color={t.colors.textPrimary} size={t.iconSize.navigation} />
          </LiquidGlassButton>
        ) : null}
        <View testID="tablet-main-title" style={styles.title}>
          {effectiveShowSearch ? (
            <SessionSearchField
              ref={searchInputRef}
              value={searchQuery}
              autoFocus={false}
              onFocus={useSearchStore.getState().openTabletSearch}
              onChangeText={(query) => {
                useSearchStore.getState().openTabletSearch();
                useSearchStore.getState().setQuery(query);
              }}
            />
          ) : (
            <RootSectionHeaderTitle
              section={activeSection.kind === 'daily' ? 'DailyTab' : 'ProjectTab'}
              title={title}
            />
          )}
        </View>
        {view === 'board' && !effectiveShowSearch ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.uiSpacing.sm }}>
          <LiquidGlassButton iconOnly borderRadius={t.foundation.radius.round}
            accessibilityLabel="드래프트 카드 추가" onPress={() => boardRef.current?.openCreate()}>
            <Ionicons name="add-outline" size={t.iconSize.standard} color={t.colors.textPrimary} />
          </LiquidGlassButton>
          <CompletedCardsToggle {...cardDisplay} />
          <LiquidGlassButton iconOnly borderRadius={t.foundation.radius.round} accessibilityLabel="보드 확대" onPress={() => boardRef.current?.openExpanded()}>
            <Ionicons name="expand-outline" size={t.iconSize.standard} color={t.colors.textPrimary} />
          </LiquidGlassButton>
        </View> : null}
        {activeSection.kind === 'daily' && !effectiveShowSearch && view === 'existing' ? (
          <DailyHeaderActions
            onOpenReview={() => dailyRef.current?.openReview()}
            onOpenNewFolder={() => dailyRef.current?.openNewFolder()}
          />
        ) : null}
      </TabletPaneHeader>
      {!effectiveShowSearch && activeSection.kind === 'project' ? <View style={{ paddingHorizontal: t.tabletShell.header.paddingHorizontal, paddingBottom: t.uiSpacing.sm }}>
        <SettingsSegmentedControl<'existing' | 'board'> id="tablet-card-view" value={view} onChange={setView}
          options={[{ value: 'existing', label: '기존 보기' }, { value: 'board', label: '카드 보드' }]} />
      </View> : null}
      <View style={styles.body}>
        {visited[viewKey] ? <View style={{ flex: 1, display: view === 'board' ? 'flex' : 'none' }}>
          <CardBoardWorkspace ref={boardRef} externalHeader key={displayOwner} api={api} folderId={activeSection.kind === 'project' ? activeSection.folderId : undefined}
            cardDisplay={cardDisplay} reserveHomeComposerSpace onOpen={(id) => useUIStore.getState().openCardOverlay(id)} />
        </View> : null}
        {view === 'existing' && activeSection.kind === 'daily' ? (
          <DailyPlannerScreen
            ref={dailyRef}
            date={activeSection.date}
            layout="tablet"
            onOpenSession={(id) => useUIStore.getState().openSessionOverlay(id)}
            onDateChange={(date) => {
              recordUiUsageEvent({
                type: 'view_open',
                target: { kind: 'view', id: `daily:${date}` },
                from: { kind: 'view', id: `daily:${activeSection.date}` },
                entry: 'nav',
              });
              setActiveSection({ kind: 'daily', date });
            }}
            onOpenFolder={openPlannerFolderWorkspace}
          />
        ) : null}
        {view === 'existing' && activeSection.kind === 'project' ? (
          <FolderWorkspace
            api={api}
            folderId={activeSection.folderId}
            folderPageId={activeSection.projectPageId}
            cardDisplay={cardDisplay}
            onOpenFolder={(folderId, projectPageId) => setActiveSection({
              kind: 'project', folderId, projectPageId,
            })}
          />
        ) : null}
      </View>
    </View>
  );
}

function makeStyles(t: DesignTokens) {
  return StyleSheet.create({
    container: { flex: 1 },
    title: { flex: 1, flexShrink: 1 },
    headerAction: {
      minWidth: t.hitTarget.min,
      minHeight: t.hitTarget.min,
    },
    body: { flex: 1 },
  });
}
