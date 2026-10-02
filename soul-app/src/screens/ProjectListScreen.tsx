import React, { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { createApiClient } from '../api/client';
import type { Folder } from '../api/types';
import { useSessionStore } from '../store/sessionStore';
import { useSettingsStore } from '../store/settingsStore';
import { createPlannerVisualRoles, useTokens, type DesignTokens } from '../theme';
import { AppGlassCard } from '../components/AppGlassCard';
import { ProjectTreeSheet } from '../components/planner/ProjectTreeSheet';
import { usePlannerActions } from '../hooks/usePlannerActions';
import { usePlannerContextMenus } from '../hooks/usePlannerContextMenus';
import { useUIStore } from '../store/uiStore';
import {
  promptText,
  reportPlannerError,
  showProjectManagement,
} from '../components/planner/projectManagement';
import { buildPlannerProjectTreeRows } from '../lib/planner-project-tree';

export function ProjectHeaderAddButton() {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);
  const serverUrl = useSettingsStore((state) => state.serverUrl);
  const api = useMemo(() => serverUrl ? createApiClient(serverUrl) : null, [serverUrl]);
  const actions = usePlannerActions(api);
  return (
    <TouchableOpacity
      testID="project-header-add"
      accessibilityLabel="새 프로젝트"
      style={styles.headerAction}
      onPress={() => promptText('새 프로젝트', '프로젝트 이름', (name) => {
        void actions.createRootFolder(name).catch(reportPlannerError('프로젝트를 만들지 못했습니다.'));
      })}
    >
      <Ionicons name="add" color={t.colors.accent} size={t.iconSize.action} />
    </TouchableOpacity>
  );
}

export function ProjectListScreen({
  onOpenProject,
}: {
  onOpenProject?: (folder: Folder, projectPageId: string) => void;
}) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);
  const folders = useSessionStore((state) => state.catalog.folders);
  const serverUrl = useSettingsStore((state) => state.serverUrl);
  const api = useMemo(() => serverUrl ? createApiClient(serverUrl) : null, [serverUrl]);
  const actions = usePlannerActions(api);
  const menus = usePlannerContextMenus(api);
  const today = useUIStore((state) => state.todayDate);
  const [expandedFolderIds, setExpandedFolderIds] = useState<Set<string>>(new Set());
  const rows = useMemo(
    () => buildPlannerProjectTreeRows(folders, expandedFolderIds),
    [expandedFolderIds, folders],
  );
  const [viewportHeight, setViewportHeight] = useState(0);
  const [contentMetrics, setContentMetrics] = useState({ rowCount: 0, height: 0 });
  const estimatedContentHeight = estimateProjectTreeHeight(rows.length, t.foundation.minHeight.row);
  const contentHeight = contentMetrics.rowCount === rows.length
    ? Math.max(contentMetrics.height, estimatedContentHeight)
    : estimatedContentHeight;
  const panelHeight = resolveProjectGlassPanelHeight({
    hasRows: rows.length > 0,
    contentHeight,
    viewportHeight,
    verticalInset: t.uiSpacing.lg,
  });

  const createFolder = (folder: Folder, projectPageId: string) =>
    promptText('새 폴더', '폴더 이름', (title) => {
      void actions.createFolder({
        title,
        folderId: folder.id,
        projectPageId,
        dailyDate: today,
      }).catch(reportPlannerError('폴더를 만들지 못했습니다.'));
    });
  return (
    <View
      testID="project-list-root"
      style={styles.container}
      onLayout={(event) => setViewportHeight(event.nativeEvent.layout.height)}
    >
      {/* Native GlassView는 ScrollView 안에서 이동·clip하지 않도록 고정 sibling으로 둔다. */}
      {rows.length > 0 && panelHeight > 0 ? (
        <AppGlassCard
          role="glassCard"
          testID="project-list-glass-background"
          style={[styles.panelFrame, { height: panelHeight }]}
        />
      ) : null}
      <ScrollView
        testID="project-list-scroll"
        style={rows.length > 0
          ? [styles.panelFrame, { height: panelHeight }]
          : styles.emptyScroll}
        contentContainerStyle={rows.length > 0 ? styles.content : styles.emptyContent}
        onContentSizeChange={(_width, height) => {
          if (rows.length === 0) return;
          setContentMetrics((current) => (
            current.rowCount === rows.length && current.height === height
              ? current
              : { rowCount: rows.length, height }
          ));
        }}
      >
        <ProjectTreeSheet
          rows={rows}
          onToggle={(folderId) => setExpandedFolderIds((current) => {
            const next = new Set(current);
            if (next.has(folderId)) next.delete(folderId);
            else next.add(folderId);
            return next;
          })}
          onOpen={(folder, projectPageId) => onOpenProject?.(folder, projectPageId)}
          onLongPress={(folder, projectPageId) => menus.openProjectMenu({
            folder,
            projectPageId,
            onOpen: () => onOpenProject?.(folder, projectPageId),
            onCreateFolder: () => createFolder(folder, projectPageId),
          })}
          onManage={(folder) => showProjectManagement(folder, actions)}
        />
        {rows.length === 0 ? <Text style={styles.empty}>프로젝트가 없습니다.</Text> : null}
      </ScrollView>
    </View>
  );
}
function makeStyles(t: DesignTokens) {
  const planner = createPlannerVisualRoles(t);
  return StyleSheet.create({
    container: { flex: 1, overflow: 'hidden' },
    panelFrame: {
      position: 'absolute',
      top: t.uiSpacing.lg,
      left: planner.pageInset,
      right: planner.pageInset,
      borderRadius: t.foundation.radius.card,
      overflow: 'hidden',
    },
    content: {
      paddingHorizontal: 0,
      paddingVertical: 0,
      gap: t.cardLayout.gap,
    },
    emptyScroll: { flex: 1 },
    emptyContent: {
      paddingHorizontal: planner.pageInset,
      paddingVertical: t.uiSpacing.lg,
      gap: t.cardLayout.gap,
    },
    headerAction: {
      width: t.hitTarget.min,
      height: t.hitTarget.min,
      alignItems: 'center',
      justifyContent: 'center',
    },
    empty: { color: t.colors.textPlaceholder, ...planner.typography.body },
  });
}

function estimateProjectTreeHeight(rowCount: number, minRowHeight: number): number {
  if (rowCount <= 0) return 0;
  return rowCount * minRowHeight + (rowCount - 1) * StyleSheet.hairlineWidth;
}

export function resolveProjectGlassPanelHeight({
  hasRows,
  contentHeight,
  viewportHeight,
  verticalInset,
}: {
  hasRows: boolean;
  contentHeight: number;
  viewportHeight: number;
  verticalInset: number;
}): number {
  if (!hasRows) return 0;
  const safeContentHeight = Math.max(0, contentHeight);
  if (viewportHeight <= 0) return 0;
  const availableHeight = Math.max(0, viewportHeight - verticalInset * 2);
  return Math.min(safeContentHeight, availableHeight);
}
