import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { PlannerFolder, PlannerFolderStatus } from '../../api/plannerTypes';
import { splitPlannerContentLabel } from '../../lib/planner-project-tree';
import { createPlannerVisualRoles, useTokens, type DesignTokens } from '../../theme';
import { GroupedGlassRow } from './GroupedGlassSheet';

const STATUS_LABEL: Record<PlannerFolderStatus, string> = {
  open: '○ 열림',
  in_progress: '● 진행',
  review: '◆ 검수',
  completed: '✓ 완료',
};

export function PlannerFolderRow({
  folder,
  onPress,
  onLongPress,
  parentNavigation = false,
}: {
  folder: PlannerFolder;
  onPress?: () => void;
  onLongPress?: () => void;
  parentNavigation?: boolean;
}) {
  const t = useTokens();
  const planner = useMemo(() => createPlannerVisualRoles(t), [t]);
  const styles = useMemo(() => makeStyles(t), [t]);
  const label = splitPlannerContentLabel(folder.page.title);
  const meta = [
    folder.assignee,
    folder.progress == null ? null : `${folder.progress}%`,
    folder.contextCount > 0 ? `컨텍스트 ${folder.contextCount}` : null,
  ].filter(Boolean).join(' · ');
  return (
    <GroupedGlassRow
      testID={`planner-task-row-${folder.page.id}`}
      accessibilityLabel={parentNavigation ? `상위 폴더 ${folder.page.title}` : folder.page.title}
      onPress={onPress}
      onLongPress={onLongPress}
      style={styles.row}
    >
      <View testID={`planner-task-leading-${folder.page.id}`} style={styles.leading}>
        {parentNavigation ? <Ionicons name="folder-outline" size={t.iconSize.prominent} color={t.colors.textMuted} />
          : label.emoji ? <Text style={styles.emoji}>{label.emoji}</Text> : null}
      </View>
      <View style={styles.copy}>
        {parentNavigation ? <Text style={styles.caption}>상위 폴더</Text> : null}
        <Text
          testID={`planner-task-title-${folder.page.id}`}
          style={styles.title}
          numberOfLines={1}
          ellipsizeMode="tail"
        >
          {label.title}
        </Text>
        {!parentNavigation ? <Text
          testID={`planner-task-meta-${folder.page.id}`}
          style={styles.meta}
          numberOfLines={1}
          ellipsizeMode="tail"
        >
          {meta}
        </Text> : null}
      </View>
      {parentNavigation ? <View testID="planner-task-parent-arrow" style={styles.parentArrow}>
        <Ionicons name="arrow-up" size={t.iconSize.standard} color={t.colors.textMuted} />
      </View> : <Text
        testID={`planner-task-status-${folder.page.id}`}
        style={[styles.status, { color: planner.statusTone[folder.status] }]}
        numberOfLines={1}
      >
        {STATUS_LABEL[folder.status]}
      </Text>}
    </GroupedGlassRow>
  );
}

function makeStyles(t: DesignTokens) {
  const planner = createPlannerVisualRoles(t);
  return StyleSheet.create({
    row: {
      minHeight: planner.minHeight.folder,
      paddingHorizontal: t.cardLayout.padding,
      paddingVertical: t.uiSpacing.sm,
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.uiSpacing.sm,
    },
    leading: {
      width: planner.contentIconFrame,
      height: planner.contentIconFrame,
      alignItems: 'center',
      justifyContent: 'center',
    },
    emoji: { ...planner.typography.body },
    copy: { flex: 1, minWidth: 0, gap: t.uiSpacing.xxs },
    title: { color: t.colors.textPrimary, ...planner.typography.cardTitle },
    meta: { color: t.colors.textSecondary, ...planner.typography.meta },
    caption: { color: t.colors.textSecondary, ...planner.typography.meta },
    parentArrow: { width: planner.statusColumn, flexShrink: 0, alignItems: 'flex-end', justifyContent: 'center' },
    status: {
      width: planner.statusColumn,
      flexShrink: 0,
      textAlign: 'right',
      ...planner.typography.label,
    },
  });
}
