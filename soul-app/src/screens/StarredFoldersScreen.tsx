import React, { useCallback, useMemo, useState } from 'react';
import { Alert, RefreshControl, ScrollView, StyleSheet } from 'react-native';
import { createApiClient } from '../api/client';
import type { PlannerFolder } from '../api/plannerTypes';
import { StarredFolderList } from '../components/planner/StarredFolderList';
import { usePlannerContextMenus } from '../hooks/usePlannerContextMenus';
import { usePlannerStarred } from '../hooks/usePlannerReads';
import { useSettingsStore } from '../store/settingsStore';
import { createPlannerVisualRoles, useTokens, type DesignTokens } from '../theme';
import { createSurfaceRoles } from '../theme/surfaceRoles';

export function StarredFoldersScreen({
  active = true,
  onOpenFolder,
}: {
  active?: boolean;
  onOpenFolder?: (folder: PlannerFolder) => void;
}) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);
  const serverUrl = useSettingsStore((state) => state.serverUrl);
  const api = useMemo(() => serverUrl ? createApiClient(serverUrl) : null, [serverUrl]);
  const starred = usePlannerStarred(api, active);
  const menus = usePlannerContextMenus(api);
  const [dragging, setDragging] = useState(false);
  const moveFolderOrder = useCallback(async (sourcePageId: string, beforePageId: string | null) => {
    try {
      await starred.moveFolderOrder(sourcePageId, beforePageId);
    } catch (cause) {
      Alert.alert(
        '작업을 완료하지 못했습니다.',
        cause instanceof Error ? cause.message : String(cause),
      );
    }
  }, [starred.moveFolderOrder]);

  return (
    <ScrollView
      testID="starred-task-scroll"
      style={styles.container}
      contentContainerStyle={styles.content}
      scrollEnabled={!dragging && !starred.reordering}
      refreshControl={(
        <RefreshControl refreshing={starred.loading} onRefresh={starred.refresh} />
      )}
    >
      <StarredFolderList
        folders={starred.data.items}
        loading={starred.loading}
        error={starred.error}
        hasMore={!!starred.data.nextCursor}
        onLoadMore={starred.loadMore}
        onRefresh={starred.refresh}
        refreshRequired={starred.refreshRequired}
        onSelect={(folder) => onOpenFolder?.(folder)}
        onLongPress={(folder) => menus.openFolderMenu(folder, () => onOpenFolder?.(folder))}
        onMove={moveFolderOrder}
        onDragStateChange={setDragging}
        reordering={starred.reordering}
      />
    </ScrollView>
  );
}

function makeStyles(t: DesignTokens) {
  const roles = createSurfaceRoles(t);
  const planner = createPlannerVisualRoles(t);
  return StyleSheet.create({
    container: { flex: 1, ...roles.canvas.tokenStyle },
    content: { padding: planner.pageInset },
  });
}
