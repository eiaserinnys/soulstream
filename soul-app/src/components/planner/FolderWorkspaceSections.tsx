import React, { useMemo } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import type { ApiClient } from '../../api/client';
import type { PlannerFolderDetail } from '../../api/plannerTypes';
import type { Folder } from '../../api/types';
import { usePlannerActions } from '../../hooks/usePlannerActions';
import { usePlannerContextMenus } from '../../hooks/usePlannerContextMenus';
import { useSessionStore } from '../../store/sessionStore';
import { useUIStore } from '../../store/uiStore';
import { createPlannerVisualRoles, useTokens, type DesignTokens } from '../../theme';
import { GroupedGlassSheet } from './GroupedGlassSheet';
import { NewFolderSheet } from './NewFolderSheet';
import { PlannerFolderRow } from './PlannerFolderRow';
import { ProjectContextEditor } from './ProjectContextEditor';
import { PlannerSectionHeader } from './PlannerSectionHeader';
import { folderPage, folderWorkspaceSummary } from './folderWorkspaceModel';

export function FolderWorkspaceSections({
  api, folder, detail, loading, error, active, loadMoreSubfolders, onOpenFolder,
  parentFolder, newFolderDraft, onNewFolderDraftChange,
}: {
  api: ApiClient | null;
  folder: Folder;
  detail: PlannerFolderDetail | undefined;
  loading: boolean;
  error: string | null;
  active: boolean;
  loadMoreSubfolders(): void;
  onOpenFolder?: (folderId: string, pageId: string, name: string) => void;
  parentFolder?: Folder;
  newFolderDraft: { parentPageId: string } | null;
  onNewFolderDraftChange(draft: { parentPageId: string } | null): void;
}) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);
  const menus = usePlannerContextMenus(api);
  const actions = usePlannerActions(api);
  const folders = useSessionStore((state) => state.catalog.folders);
  const today = useUIStore((state) => state.todayDate);
  const children = detail?.subfolders.items ?? [];
  return (
    <>
      <ProjectContextEditor api={api} projectPageId={folder.projectPageId!} active={active} />
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {!detail && loading ? <ActivityIndicator color={t.colors.accent} /> : null}
      <View style={styles.section}>
        <PlannerSectionHeader title="하위 폴더" testID="planner-section-header-subfolders"
          actionLabel="새 폴더"
          onAction={() => onNewFolderDraftChange({ parentPageId: folder.projectPageId! })} />
        <GroupedGlassSheet testID="folder-child-sheet">
          {parentFolder?.projectPageId && onOpenFolder ? (
            <PlannerFolderRow
              parentNavigation
              folder={folderWorkspaceSummary(parentFolder, folderPage(parentFolder))}
              onPress={() => onOpenFolder(parentFolder.id, parentFolder.projectPageId!, parentFolder.name)}
            />
          ) : null}
          {children.map((child) => {
            const open = () => onOpenFolder?.(child.id, child.projectPageId!, child.name);
            return (
              <PlannerFolderRow
                key={child.id}
                folder={folderWorkspaceSummary(child, folderPage(child))}
                onPress={open}
                onLongPress={() => menus.openChildFolderManagement(child)}
              />
            );
          })}
        </GroupedGlassSheet>
        {detail?.subfolders.nextCursor ? (
          <TouchableOpacity style={styles.action} onPress={loadMoreSubfolders}>
            <Text style={styles.link}>하위 폴더 더 보기</Text>
          </TouchableOpacity>
        ) : null}
      </View>
      <NewFolderSheet
        visible={newFolderDraft !== null}
        api={api}
        folders={folders}
        dailyDate={today}
        defaultProjectPageId={newFolderDraft?.parentPageId ?? folder.projectPageId!}
        onClose={() => onNewFolderDraftChange(null)}
        onSubmit={actions.createFolder}
      />
    </>
  );
}

function makeStyles(t: DesignTokens) {
  const planner = createPlannerVisualRoles(t);
  return StyleSheet.create({
    section: { gap: t.spacing.sm },
    link: { color: t.colors.accent, ...planner.typography.label },
    action: { minWidth: planner.actionColumn, minHeight: planner.actionColumn, justifyContent: 'center' },
    error: { color: t.colors.errorText, ...planner.typography.body },
  });
}
