import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  FlatList,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { createApiClient } from '../../api/client';
import { StarredFolderList } from '../planner/StarredFolderList';
import { usePlannerDailyHistory, usePlannerStarred } from '../../hooks/usePlannerReads';
import { buildPlannerProjectTreeRows } from '../../lib/planner-project-tree';
import { openStarredPageWorkspace } from '../../lib/planner-folder-workspace';
import { useSessionStore } from '../../store/sessionStore';
import { useSettingsStore } from '../../store/settingsStore';
import { useUIStore, type ActiveSection } from '../../store/uiStore';
import { createPlannerVisualRoles, useTokens, type DesignTokens } from '../../theme';
import {
  ROOT_SECTION_CONFIG,
  type RootSectionKey,
} from '../../navigation/rootSectionConfig';
import { AppGlassPressable } from '../AppGlassCard';
import { usePlannerActions } from '../../hooks/usePlannerActions';
import { usePlannerContextMenus } from '../../hooks/usePlannerContextMenus';
import {
  promptText,
  reportPlannerError,
  showProjectManagement,
} from '../planner/projectManagement';
import { SettingsModal } from '../settings/SettingsModal';
import { ProjectTreeSheet } from '../planner/ProjectTreeSheet';
import { TabletPaneHeader } from './TabletPaneHeader';
import { resolveTabletBottomSafeAreaPadding } from './tabletShellInsets';
import { SessionSearchField } from '../search/SessionSearchField';
import { useSearchStore } from '../../store/searchStore';
import { recordUiUsageEvent } from '../../lib/ui-usage-events';

interface Props {
  onItemSelected?: () => void;
  topInsetPadding?: boolean;
  active?: boolean;
  showSearch?: boolean;
}

export function SidebarPane({
  onItemSelected,
  topInsetPadding = false,
  active = true,
  showSearch = false,
}: Props) {
  const t = useTokens();
  const planner = useMemo(() => createPlannerVisualRoles(t), [t]);
  const styles = useMemo(() => makeStyles(t), [t]);
  const insets = useSafeAreaInsets();
  const bottomSafeAreaPadding = resolveTabletBottomSafeAreaPadding(
    insets.bottom,
    t.tabletShell.outerInset,
  );
  const folders = useSessionStore((state) => state.catalog.folders);
  const activeSection = useUIStore((state) => state.activeSection);
  const setActiveSection = useUIStore((state) => state.setActiveSection);
  const serverUrl = useSettingsStore((state) => state.serverUrl);
  const api = useMemo(() => serverUrl ? createApiClient(serverUrl) : null, [serverUrl]);
  const starred = usePlannerStarred(api, active);
  const today = useUIStore((state) => state.todayDate);
  const dailyHistory = usePlannerDailyHistory(api, today, active);
  const actions = usePlannerActions(api);
  const menus = usePlannerContextMenus(api);
  const [starredDragging, setStarredDragging] = useState(false);
  const dailyDates = useMemo(
    () => Array.from(new Set([today, ...dailyHistory.dates])),
    [dailyHistory.dates, today],
  );
  const [expandedFolderIds, setExpandedFolderIds] = useState<Set<string>>(new Set());
  const treeRows = useMemo(
    () => buildPlannerProjectTreeRows(folders, expandedFolderIds),
    [expandedFolderIds, folders],
  );
  const settingsVisible = useUIStore((state) => state.settingsVisible);
  const searchQuery = useSearchStore((state) => state.query);
  const searchFocusRequestId = useSearchStore((state) => state.focusRequestId);
  const searchInputRef = useRef<TextInput>(null);
  const openSettings = useUIStore((state) => state.openSettings);
  const closeSettings = useUIStore((state) => state.closeSettings);

  useEffect(() => {
    if (showSearch && searchFocusRequestId > 0) {
      requestAnimationFrame(() => searchInputRef.current?.focus());
    }
  }, [searchFocusRequestId, showSearch]);

  const select = useCallback((section: ActiveSection) => {
    recordUiUsageEvent({
      type: 'view_open',
      target: sectionTarget(section),
      from: sectionTarget(activeSection),
      entry: 'sidebar',
    });
    setActiveSection(section);
    onItemSelected?.();
  }, [activeSection, onItemSelected, setActiveSection]);

  const moveStarredFolder = useCallback(async (
    sourcePageId: string,
    beforePageId: string | null,
  ) => {
    try {
      await starred.moveFolderOrder(sourcePageId, beforePageId);
    } catch (cause) {
      reportPlannerError('작업을 완료하지 못했습니다.')(cause);
    }
  }, [starred.moveFolderOrder]);

  const isActive = (section: ActiveSection) => {
    if (section.kind !== activeSection.kind) return false;
    if (section.kind === 'daily' && activeSection.kind === 'daily') {
      return section.date === activeSection.date;
    }
    if (section.kind === 'project' && activeSection.kind === 'project') {
      return section.projectPageId === activeSection.projectPageId;
    }
    return true;
  };

  return (
    <>
    <View
      style={[styles.container, topInsetPadding && { paddingTop: insets.top }]}
    >
      <TabletPaneHeader testID="tablet-sidebar-header">
        <SidebarSectionTitle
          testID="sidebar-section-daily"
          section="DailyTab"
          styles={styles}
          t={t}
        />
      </TabletPaneHeader>
      {showSearch ? (
        <View style={styles.searchField}>
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
        </View>
      ) : null}
      <FlatList
        testID="sidebar-main-list"
        style={styles.list}
        scrollEnabled={!starredDragging && !starred.reordering}
        data={treeRows.length > 0 ? ['project-tree'] : []}
        keyExtractor={(item) => item}
        renderItem={() => (
          <ProjectTreeSheet
            rows={treeRows}
            activeProjectPageId={activeSection.kind === 'project'
              ? activeSection.projectPageId
              : null}
            onToggle={(folderId) => setExpandedFolderIds((current) => {
              const next = new Set(current);
              if (next.has(folderId)) next.delete(folderId);
              else next.add(folderId);
              return next;
            })}
            onOpen={(folder, projectPageId) => select({
              kind: 'project',
              folderId: folder.id,
              projectPageId,
            })}
            onLongPress={(folder, projectPageId) => menus.openProjectMenu({
              folder,
              projectPageId,
              onOpen: () => select({ kind: 'project', folderId: folder.id, projectPageId }),
              onCreateFolder: () => promptText('새 폴더', '폴더 이름', (title) => {
                void actions.createFolder({
                  title,
                  folderId: folder.id,
                  projectPageId,
                  dailyDate: today,
                }).catch(reportPlannerError('폴더를 만들지 못했습니다.'));
              }),
            })}
            onManage={(folder) => showProjectManagement(folder, actions)}
          />
        )}
        ListHeaderComponent={
          <View style={styles.headerContent}>
            <View testID="sidebar-daily-date-list" style={styles.dateList}>
              {dailyDates.map((date, index) => {
                const section: ActiveSection = { kind: 'daily', date };
                return (
                  <SidebarRow
                    key={date}
                    label={index === 0 ? `오늘 · ${date}` : date}
                    icon="calendar-outline"
                    active={isActive(section) && activeSection.kind === 'daily' && activeSection.date === date}
                    onPress={() => select(section)}
                    styles={styles}
                    t={t}
                  />
                );
              })}
            </View>
            <View testID="sidebar-starred-section" style={styles.starred}>
              <SidebarSectionTitle
                testID="sidebar-section-starred"
                section="StarredTab"
                styles={styles}
                t={t}
              />
              <StarredFolderList
                folders={starred.data.items}
                loading={starred.loading}
                error={starred.error}
                hasMore={!!starred.data.nextCursor}
                onLoadMore={starred.loadMore}
                onRefresh={starred.refresh}
                refreshRequired={starred.refreshRequired}
                onSelect={(folder) => {
                  openStarredPageWorkspace(folder.page.id, 'sidebar');
                  onItemSelected?.();
                }}
                onLongPress={(folder) => {
                  menus.openFolderMenu(folder, () => {
                    openStarredPageWorkspace(folder.page.id, 'sidebar');
                    onItemSelected?.();
                  });
                }}
                onMove={moveStarredFolder}
                onDragStateChange={setStarredDragging}
                reordering={starred.reordering}
              />
            </View>
            <View style={styles.sectionHeader}>
              <SidebarSectionTitle
                testID="sidebar-section-project"
                section="ProjectTab"
                styles={styles}
                t={t}
              />
              <TouchableOpacity
                accessibilityLabel="새 프로젝트"
                style={styles.iconAction}
                onPress={() => promptText('새 프로젝트', '프로젝트 이름', (name) => {
                  void actions.createRootFolder(name).catch(reportPlannerError('프로젝트를 만들지 못했습니다.'));
                })}
              >
                <Ionicons name="add" color={t.colors.accent} size={t.iconSize.action} />
              </TouchableOpacity>
            </View>
          </View>
        }
      />
      <View
        testID="sidebar-settings-footer"
        style={[
          styles.footer,
          { paddingBottom: Math.max(t.cardLayout.gap, bottomSafeAreaPadding) },
        ]}
      >
        <SidebarRow
          label={ROOT_SECTION_CONFIG.SettingsTab.title}
          icon={ROOT_SECTION_CONFIG.SettingsTab.icon}
          active={false}
          onPress={openSettings}
          styles={styles}
          t={t}
        />
      </View>
    </View>
    <SettingsModal visible={settingsVisible} onClose={closeSettings} />
    </>
  );
}

function sectionTarget(section: ActiveSection) {
  return section.kind === 'project'
    ? { kind: 'page' as const, id: section.projectPageId }
    : { kind: 'view' as const, id: `daily:${section.date}` };
}

function SidebarSectionTitle({ testID, section, styles, t }: {
  testID: string;
  section: RootSectionKey;
  styles: ReturnType<typeof makeStyles>;
  t: DesignTokens;
}) {
  const config = ROOT_SECTION_CONFIG[section];
  return (
    <View testID={testID} style={styles.sectionTitle}>
      <Ionicons
        testID={`${testID}-icon`}
        name={config.icon}
        color={t.colors.textSecondary}
        size={t.iconSize.standard}
      />
      <Text
        testID={testID === 'sidebar-section-daily' ? 'tablet-sidebar-title' : undefined}
        style={styles.sectionLabel}
      >
        {config.title}
      </Text>
    </View>
  );
}

function SidebarRow({ label, icon, active, onPress, styles, t }: {
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  active: boolean;
  onPress: () => void;
  styles: ReturnType<typeof makeStyles>;
  t: DesignTokens;
}) {
  return (
    <AppGlassPressable
      style={active && styles.rowActive}
      contentStyle={styles.row}
      onPress={onPress}
    >
      <Ionicons name={icon} color={active ? t.colors.accent : t.colors.textMuted} size={t.iconSize.standard} />
      <Text style={[styles.rowLabel, active && styles.rowLabelActive]}>{label}</Text>
    </AppGlassPressable>
  );
}

function makeStyles(t: DesignTokens) {
  const planner = createPlannerVisualRoles(t);
  return StyleSheet.create({
    container: { flex: 1 },
    list: {
      flex: 1,
      marginTop: -planner.sidebar.firstItemPullUp,
    },
    searchField: {
      paddingHorizontal: planner.sidebar.contentInset,
      paddingBottom: t.spacing.sm,
    },
    headerContent: { gap: planner.sidebar.sectionGap },
    dateList: {
      paddingHorizontal: planner.sidebar.contentInset,
      gap: t.cardLayout.gap,
    },
    row: {
      flexDirection: 'row', alignItems: 'center', gap: t.uiSpacing.sm,
      minHeight: t.foundation.minHeight.row,
      paddingHorizontal: t.foundation.pageInset,
      paddingVertical: t.uiSpacing.xs,
      backgroundColor: 'transparent',
    },
    rowActive: { borderColor: t.colors.accent },
    rowLabel: { flex: 1, color: t.colors.textSecondary, fontSize: t.fontSize.body },
    rowLabelActive: { color: t.colors.textPrimary, fontWeight: '600' },
    iconAction: {
      minWidth: t.foundation.iconFrame.action,
      minHeight: t.foundation.iconFrame.action,
      alignItems: 'center',
      justifyContent: 'center',
    },
    starred: {
      paddingHorizontal: planner.sidebar.contentInset,
      gap: t.cardLayout.gap,
    },
    sectionHeader: {
      minHeight: t.foundation.minHeight.secondary,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: planner.sidebar.contentInset,
    },
    sectionTitle: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.uiSpacing.sm,
    },
    sectionLabel: {
      color: t.colors.textSecondary,
      ...t.foundation.typography.section,
    },
    footer: {
      backgroundColor: 'transparent',
      paddingTop: t.cardLayout.gap,
      paddingHorizontal: planner.sidebar.contentInset,
    },
  });
}
