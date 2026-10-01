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
import { CardBoardWorkspace } from '../planner/CardBoardWorkspace';
import { useAuthScopeGeneration } from '../../lib/auth-scope';

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
  const insets = useSafeAreaInsets();
  const activeSection = useUIStore((state) => state.activeSection);
  const [view, setView] = useState<'existing' | 'board'>('existing');
  const scope = useAuthScopeGeneration();
  const displayOwner = `${scope}:${activeSection.kind === 'project' ? activeSection.folderId : 'global'}`;
  const [completed, setCompleted] = useState({ owner: displayOwner, includeCompleted: false });
  const cardDisplay = { includeCompleted: completed.owner === displayOwner && completed.includeCompleted,
    onChange: (includeCompleted: boolean) => setCompleted({ owner: displayOwner, includeCompleted }) };
  const setActiveSection = useUIStore((state) => state.setActiveSection);
  const folders = useSessionStore((state) => state.catalog.folders);
  const serverUrl = useSettingsStore((state) => state.serverUrl);
  const api = useMemo(() => serverUrl ? createApiClient(serverUrl) : null, [serverUrl]);
  const searchQuery = useSearchStore((state) => state.query);
  const searchFocusRequestId = useSearchStore((state) => state.focusRequestId);
  const searchInputRef = useRef<TextInput>(null);
  const title = activeSection.kind === 'daily'
    ? '데일리'
    : folders.find((folder) => folder.id === activeSection.folderId)?.name ?? '프로젝트';
  useEffect(() => {
    if (showSearch && searchFocusRequestId > 0) {
      requestAnimationFrame(() => searchInputRef.current?.focus());
    }
  }, [searchFocusRequestId, showSearch]);
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
          {showSearch ? (
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
        {activeSection.kind === 'daily' && !showSearch && view === 'existing' ? (
          <DailyHeaderActions
            onOpenReview={() => dailyRef.current?.openReview()}
            onOpenNewFolder={() => dailyRef.current?.openNewFolder()}
          />
        ) : null}
      </TabletPaneHeader>
      {!showSearch ? <View style={{ paddingHorizontal: t.tabletShell.header.paddingHorizontal, paddingBottom: t.uiSpacing.sm }}>
        <SettingsSegmentedControl<'existing' | 'board'> id="tablet-card-view" value={view} onChange={setView}
          options={[{ value: 'existing', label: '기존 보기' }, { value: 'board', label: '보드' }]} />
      </View> : null}
      <View style={styles.body}>
        {view === 'board' ? <CardBoardWorkspace api={api} folderId={activeSection.kind === 'project' ? activeSection.folderId : undefined}
          cardDisplay={cardDisplay} onOpen={(id) => useUIStore.getState().openCardOverlay(id)} /> : null}
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
