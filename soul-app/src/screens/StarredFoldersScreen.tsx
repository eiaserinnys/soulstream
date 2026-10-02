import React, { useCallback, useMemo, useState } from 'react';
import { Alert, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import type { ApiClient } from '../api/client';
import { AutomaticRefreshIndicator } from '../components/AutomaticRefreshIndicator';
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
  const serverUrl = useSettingsStore((state) => state.serverUrl);
  const api = useMemo(() => serverUrl ? createApiClient(serverUrl) : null, [serverUrl]);
  return <StarredFoldersWorkspace api={api} active={active} onOpenFolder={onOpenFolder} />;
}

/** Same production content with an explicit API, also used by the local review fixture. */
export function StarredFoldersWorkspace({ api, active = true, onOpenFolder }: {
  api: ApiClient | null; active?: boolean; onOpenFolder?: (folder: PlannerFolder) => void;
}) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);
  const starred = usePlannerStarred(api, active);
  const menus = usePlannerContextMenus(api);
  const [dragging, setDragging] = useState(false);
  const [pullRefreshing, setPullRefreshing] = useState(false);
  const handlePullRefresh = useCallback(async () => {
    if (pullRefreshing) return;
    setPullRefreshing(true);
    try { await starred.refresh(); }
    finally { setPullRefreshing(false); }
  }, [pullRefreshing, starred.refresh]);
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
    <View testID="starred-refresh-frame" style={styles.frame}>
    <ScrollView
      testID="starred-task-scroll"
      style={styles.container}
      contentContainerStyle={styles.content}
      scrollEnabled={!dragging && !starred.reordering}
      refreshControl={(
        <RefreshControl refreshing={pullRefreshing} onRefresh={handlePullRefresh} />
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
    {starred.loading && !pullRefreshing ? <AutomaticRefreshIndicator testID="starred-auto-progress" style={{ top: 0, right: 0 }} /> : null}
    </View>
  );
}

function makeStyles(t: DesignTokens) {
  const roles = createSurfaceRoles(t);
  const planner = createPlannerVisualRoles(t);
  return StyleSheet.create({
    frame: { flex: 1, position: 'relative', paddingTop: t.uiSpacing.xl, ...roles.canvas.tokenStyle },
    container: { flex: 1, ...roles.canvas.tokenStyle },
    content: { paddingHorizontal: planner.pageInset, paddingBottom: planner.pageInset },
  });
}
