import React, { useCallback, useMemo, useState } from 'react';
import {
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
} from 'react-native-reanimated';
import type { PlannerFolder } from '../../api/plannerTypes';
import {
  getStarredFolderMoveTarget,
  reconcileStarredFolderLayouts,
  type StarredFolderRowLayout,
} from '../../lib/starred-folder-order';
import { createPlannerVisualRoles, useTokens, type DesignTokens } from '../../theme';
import { GroupedGlassRow, GroupedGlassSheet } from './GroupedGlassSheet';
import { PlannerFolderRow } from './PlannerFolderRow';

export function StarredFolderList({
  folders,
  loading,
  error,
  hasMore,
  onLoadMore,
  onRefresh,
  refreshRequired = false,
  onSelect,
  onLongPress,
  onMove,
  onDragStateChange,
  reordering = false,
}: {
  folders: readonly PlannerFolder[];
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  onLoadMore: () => void;
  onRefresh?: () => void;
  refreshRequired?: boolean;
  onSelect?: (folder: PlannerFolder) => void;
  onLongPress?: (folder: PlannerFolder) => void;
  onMove?: (sourcePageId: string, beforePageId: string | null) => void;
  onDragStateChange?: (dragging: boolean) => void;
  reordering?: boolean;
}) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);
  const pageIds = folders.map((folder) => folder.page.id);
  const [dragging, setDragging] = useState(false);
  const [layoutState, setLayoutState] = useState<{
    listTop: number | null;
    layouts: Record<string, StarredFolderRowLayout>;
  }>({ listTop: null, layouts: {} });
  const rowLayouts = reconcileStarredFolderLayouts(
    pageIds,
    layoutState.layouts,
    layoutState.listTop,
    StyleSheet.hairlineWidth,
  );
  const orderedLayouts = pageIds
    .map((pageId) => rowLayouts[pageId])
    .filter((layout): layout is StarredFolderRowLayout => !!layout);
  const allRowsMeasured = orderedLayouts.length === folders.length;

  const handleRowLayout = useCallback((pageId: string, event: LayoutChangeEvent) => {
    const { y: top, height } = event.nativeEvent.layout;
    setLayoutState((previous) => {
      const current = previous.layouts[pageId];
      const listTop = pageId === pageIds[0] ? top : previous.listTop;
      if (current?.top === top && current.height === height && previous.listTop === listTop) {
        return previous;
      }
      return {
        listTop,
        layouts: { ...previous.layouts, [pageId]: { pageId, top, height } },
      };
    });
  }, [pageIds]);

  const handleDrop = useCallback((sourcePageId: string, dropY: number, moved: boolean) => {
    const folder = folders.find((item) => item.page.id === sourcePageId);
    if (!folder) return;
    if (!moved) {
      onLongPress?.(folder);
      return;
    }
    const beforePageId = getStarredFolderMoveTarget(
      folders,
      folder.page.id,
      orderedLayouts,
      dropY,
    );
    onMove?.(folder.page.id, beforePageId);
  }, [onLongPress, onMove, orderedLayouts, folders]);
  const handleDragStateChange = useCallback((active: boolean) => {
    setDragging(active);
    onDragStateChange?.(active);
  }, [onDragStateChange]);

  return (
    <GroupedGlassSheet testID="starred-task-sheet" style={styles.container}>
      {folders.map((folder) => (
        onMove ? (
          <DraggableStarredFolderRow
            key={folder.page.id}
            folder={folder}
            top={rowLayouts[folder.page.id]?.top ?? 0}
            enabled={!reordering && !refreshRequired && allRowsMeasured}
            onLayout={(event) => handleRowLayout(folder.page.id, event)}
            onDrop={handleDrop}
            onDragStateChange={handleDragStateChange}
            onSelect={onSelect}
          />
        ) : (
          <PlannerFolderRow
            key={folder.page.id}
            folder={folder}
            onPress={() => onSelect?.(folder)}
            onLongPress={() => onLongPress?.(folder)}
          />
        )
      ))}
      {folders.length === 0 ? (
        <View style={styles.stateRow}><Text style={styles.empty}>{loading ? '별표 목록을 불러오는 중입니다.' : error ?? '별표 카드가 없습니다.'}</Text></View>
      ) : null}
      {!loading && refreshRequired && error && folders.length > 0 ? (
        <View testID="starred-refresh-error" style={styles.stateRow}>
          <Text style={styles.empty}>{error}</Text>
        </View>
      ) : null}
      {(hasMore || refreshRequired) ? (
        <GroupedGlassRow
          testID="starred-load-more"
          onPress={refreshRequired ? onRefresh : onLoadMore}
          disabled={loading || reordering || dragging || (refreshRequired && !onRefresh)}
          style={styles.more}
        >
          <Text style={styles.moreText}>{refreshRequired ? '목록 새로고침' : '더 보기'}</Text>
        </GroupedGlassRow>
      ) : null}
    </GroupedGlassSheet>
  );
}

function DraggableStarredFolderRow({
  folder,
  top,
  enabled,
  onLayout,
  onDrop,
  onDragStateChange,
  onSelect,
}: {
  folder: PlannerFolder;
  top: number;
  enabled: boolean;
  onLayout: (event: LayoutChangeEvent) => void;
  onDrop: (sourcePageId: string, dropY: number, moved: boolean) => void;
  onDragStateChange?: (dragging: boolean) => void;
  onSelect?: (folder: PlannerFolder) => void;
}) {
  const translationY = useSharedValue(0);
  const touchStartY = useSharedValue(0);
  const dragging = useSharedValue(false);
  const moved = useSharedValue(false);
  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translationY.value }],
    opacity: dragging.value ? 0.86 : 1,
    zIndex: dragging.value ? 1 : 0,
    elevation: dragging.value ? 4 : 0,
  }));
  const gesture = useMemo(() => Gesture.Pan()
    .enabled(enabled)
    .activateAfterLongPress(350)
    .onStart((event) => {
      dragging.value = true;
      translationY.value = 0;
      touchStartY.value = event.y;
      moved.value = false;
      if (onDragStateChange) runOnJS(onDragStateChange)(true);
    })
    .onUpdate((event) => {
      translationY.value = event.translationY;
      if (Math.abs(event.translationY) > 8) moved.value = true;
    })
    .onEnd((event) => {
      const dropY = top + touchStartY.value + event.translationY;
      runOnJS(onDrop)(folder.page.id, dropY, moved.value);
    })
    .onFinalize(() => {
      dragging.value = false;
      translationY.value = 0;
      if (onDragStateChange) runOnJS(onDragStateChange)(false);
  }), [enabled, onDragStateChange, onDrop, folder, top, translationY, touchStartY, dragging, moved]);

  return (
    <Animated.View
      testID={`starred-draggable-task-row-${folder.page.id}`}
      onLayout={onLayout}
      style={animatedStyle}
    >
      <GestureDetector gesture={gesture}>
        <View collapsable={false}>
          <PlannerFolderRow folder={folder} onPress={() => onSelect?.(folder)} />
        </View>
      </GestureDetector>
    </Animated.View>
  );
}

function makeStyles(t: DesignTokens) {
  const planner = createPlannerVisualRoles(t);
  return StyleSheet.create({
    container: {},
    stateRow: {
      minHeight: planner.minHeight.row,
      justifyContent: 'center',
      paddingHorizontal: t.cardLayout.padding,
    },
    empty: { color: t.colors.textPlaceholder, ...planner.typography.meta },
    more: {
      minWidth: planner.actionColumn,
      minHeight: planner.minHeight.row,
      justifyContent: 'center',
      paddingHorizontal: t.cardLayout.padding,
    },
    moreText: { color: t.colors.accent, ...planner.typography.label },
  });
}
