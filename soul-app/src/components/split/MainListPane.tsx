import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FolderWorkspace } from '../planner/FolderWorkspace';
import { createApiClient } from '../../api/client';
import { useSettingsStore } from '../../store/settingsStore';
import { useSessionStore } from '../../store/sessionStore';
import { useUIStore } from '../../store/uiStore';
import { createSurfaceRoles, useTokens, type DesignTokens } from '../../theme';
import { LiquidGlassButton } from '../LiquidGlassButton';
import { AppGlassCard } from '../AppGlassCard';
import { RootSectionHeaderTitle } from '../navigation/RootSectionHeaderTitle';
import { TabletPaneHeader } from './TabletPaneHeader';
import { SessionSearchField } from '../search/SessionSearchField';
import { useSearchStore } from '../../store/searchStore';
import { SettingsSegmentedControl } from '../settings/SettingsSegmentedControl';
import { CardBoardHeaderActions, CardBoardWorkspace, type CardBoardWorkspaceHandle } from '../planner/CardBoardWorkspace';
import { useAuthScopeGeneration } from '../../lib/auth-scope';
import { useCardDisplay } from '../../hooks/useCardDisplay';
import { TabletPersistentEntry } from '../../navigation/TabletPersistentEntry';
import { GroupedGlassRow, GroupedGlassSheet } from '../planner/GroupedGlassSheet';
import { useDuoBandOwnsPanelActions } from '../../navigation/duoSideBand';

/** 이 폭 미만이면 보드 헤더 액션을 오버플로 메뉴로 접는다. */
export const MAIN_LIST_HEADER_OVERFLOW_MAX_WIDTH = 380;

export type MainListPaneHandle = { openCreate(): void; openExpanded(): void };

export const MainListPane = forwardRef<MainListPaneHandle, {
  onMenuPress?: () => void;
  topInsetPadding?: boolean;
  showSearch?: boolean;
  paneWidth?: number;
}>(function MainListPane({
  onMenuPress,
  topInsetPadding = false,
  showSearch = false,
  paneWidth,
}, ref) {
  const t = useTokens();
  const c = t.colors;
  const styles = useMemo(() => makeStyles(t), [t]);
  const boardRef = useRef<CardBoardWorkspaceHandle>(null);
  const [boardRefreshing, setBoardRefreshing] = useState(false);
  useImperativeHandle(ref, () => ({
    openCreate: () => boardRef.current?.openCreate(),
    openExpanded: () => boardRef.current?.openExpanded(),
  }), []);
  const duo = useDuoBandOwnsPanelActions();
  const insets = useSafeAreaInsets();
  const activeSection = useUIStore((state) => state.activeSection);
  const effectiveShowSearch = !duo && showSearch && activeSection.kind !== 'daily';
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
  useEffect(() => { if (view === 'board') setVisited(old => old[viewKey] ? old : { ...old, [viewKey]: true }); }, [view, viewKey]);
  const folderId = activeSection.kind === 'project' ? activeSection.folderId : undefined;
  const cardDisplay = useCardDisplay(folderId);
  const compactHeader = !duo && paneWidth !== undefined && paneWidth < MAIN_LIST_HEADER_OVERFLOW_MAX_WIDTH;
  const [overflowOpen, setOverflowOpen] = useState(false);
  const setActiveSection = useUIStore((state) => state.setActiveSection);
  const folders = useSessionStore((state) => state.catalog.folders);
  const serverUrl = useSettingsStore((state) => state.serverUrl);
  const api = useMemo(() => serverUrl ? createApiClient(serverUrl) : null, [serverUrl]);
  const searchQuery = useSearchStore((state) => state.query);
  const searchFocusRequestId = useSearchStore((state) => state.focusRequestId);
  const searchInputRef = useRef<TextInput>(null);
  const title = activeSection.kind === 'daily'
    ? '카드'
    : folders.find((folder) => folder.id === activeSection.folderId)?.name ?? '프로젝트';
  useEffect(() => {
    if (effectiveShowSearch && searchFocusRequestId > 0) {
      requestAnimationFrame(() => searchInputRef.current?.focus());
    }
  }, [searchFocusRequestId, effectiveShowSearch]);
  return (
    <View style={styles.container}>
      {!duo ? <TabletPaneHeader
        testID="tablet-main-header"
        style={topInsetPadding && {
          paddingTop: t.tabletShell.header.paddingVertical + insets.top,
          minHeight: t.tabletShell.header.minHeight + insets.top,
        }}
      >
        {onMenuPress ? (
          <LiquidGlassButton
            iconOnly
            borderRadius={t.foundation.radius.capsule}
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
              compact
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
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.uiSpacing.sm }}>
        {view === 'board' && !effectiveShowSearch ? <CardBoardHeaderActions cardDisplay={cardDisplay} refreshing={boardRefreshing}
          slotTestID="tablet-board-header-refresh-slot" compact={compactHeader} overflowOpen={overflowOpen}
          onToggleOverflow={() => setOverflowOpen(open => !open)} onCreate={() => boardRef.current?.openCreate()} onExpand={() => boardRef.current?.openExpanded()} /> : null}
        <TabletPersistentEntry />
        </View>
      </TabletPaneHeader> : null}
      {!duo && activeSection.kind === 'project' ? <View style={{ paddingHorizontal: t.tabletShell.header.paddingHorizontal, paddingBottom: t.uiSpacing.sm }}>
        <SettingsSegmentedControl<'existing' | 'board'> id="tablet-card-view" value={view} onChange={setView}
          options={[{ value: 'existing', label: '기존 보기' }, { value: 'board', label: '카드 보드' }]} />
      </View> : null}
      <View style={styles.body}>
        {visited[viewKey] ? <View style={{ flex: 1, display: view === 'board' ? 'flex' : 'none' }}>
          <CardBoardWorkspace ref={boardRef} externalHeader={!effectiveShowSearch} key={displayOwner} api={api} folderId={activeSection.kind === 'project' ? activeSection.folderId : undefined}
            title={effectiveShowSearch ? title : undefined}
            cardDisplay={cardDisplay} reserveHomeComposerSpace onAutoRefreshChange={duo ? undefined : setBoardRefreshing} onOpen={(id) => useUIStore.getState().openCardOverlay(id)} />
        </View> : null}
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
      {compactHeader && overflowOpen ? (
        <>
          <Pressable
            testID="board-header-overflow-backdrop"
            accessibilityRole="button"
            accessibilityLabel="보드 메뉴 닫기"
            onPress={() => setOverflowOpen(false)}
            style={[
              StyleSheet.absoluteFill,
              { minWidth: t.hitTarget.min, minHeight: t.hitTarget.min, zIndex: 19 },
            ]}
          />
          <View style={{
            position: 'absolute',
            top: (topInsetPadding ? insets.top : 0) + t.tabletShell.header.minHeight,
            right: t.tabletShell.header.paddingHorizontal,
            minWidth: 200,
            zIndex: 20,
          }}>
          <AppGlassCard
            role="modal"
            cornerRadius={t.foundation.radius.root}
            testID="board-header-overflow-menu"
            style={{ overflow: 'hidden' }}
          >
          <GroupedGlassSheet
            surface="inherited"
            style={{ backgroundColor: createSurfaceRoles(t).modal.fallbackColor }}
          >
            <GroupedGlassRow
              compact
              style={{ justifyContent: 'flex-start', paddingHorizontal: t.uiSpacing.md }}
              testID="board-header-overflow-create"
              accessibilityLabel="드래프트 카드 추가"
              onPress={() => {
                setOverflowOpen(false);
                boardRef.current?.openCreate();
              }}
            >
              <View style={{ alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: t.uiSpacing.sm }}>
                <Ionicons name="add-outline" size={t.iconSize.standard} color={c.textPrimary} />
                <Text style={[t.foundation.typography.body, { color: c.textPrimary }]}>드래프트 카드 추가</Text>
              </View>
            </GroupedGlassRow>
            <GroupedGlassRow
              compact
              style={{ justifyContent: 'flex-start', paddingHorizontal: t.uiSpacing.md }}
              testID="board-header-overflow-hide-done"
              accessibilityLabel="완료·취소 숨김"
              selected={!cardDisplay.includeCompleted}
              onPress={() => {
                setOverflowOpen(false);
                cardDisplay.onChange(!cardDisplay.includeCompleted);
              }}
            >
              <View style={{ alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: t.uiSpacing.sm }}>
                <Ionicons
                  name={!cardDisplay.includeCompleted ? 'eye-off-outline' : 'eye-outline'}
                  size={t.iconSize.standard}
                  color={!cardDisplay.includeCompleted ? c.accent : c.textPrimary}
                />
                <Text style={[t.foundation.typography.body, { color: !cardDisplay.includeCompleted ? c.accent : c.textPrimary }]}>완료·취소 숨김</Text>
              </View>
            </GroupedGlassRow>
              <GroupedGlassRow
                compact
                style={{ justifyContent: 'flex-start', paddingHorizontal: t.uiSpacing.md }}
                testID="board-header-overflow-expand"
                accessibilityLabel="보드 확대"
                onPress={() => {
                  setOverflowOpen(false);
                  boardRef.current?.openExpanded();
                }}
              >
                <View style={{ alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: t.uiSpacing.sm }}>
                  <Ionicons name="expand-outline" size={t.iconSize.standard} color={c.textPrimary} />
                  <Text style={[t.foundation.typography.body, { color: c.textPrimary }]}>보드 확대</Text>
                </View>
              </GroupedGlassRow>
          </GroupedGlassSheet>
          </AppGlassCard>
        </View>
        </>
      ) : null}
    </View>
  );
});

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
