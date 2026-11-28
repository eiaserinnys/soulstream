import { useMemo } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import type { PlannerFolder } from '../../api/plannerTypes';
import { createPlannerVisualRoles, useTokens, type DesignTokens } from '../../theme';
import { GroupedGlassSheet } from './GroupedGlassSheet';

/** Status and assignee of the folder. Guidance, references and defaults live in FolderContextSection. */
export function FolderWorkspaceDetails({
  folderSummary,
  onEditTitle,
}: {
  folderSummary: PlannerFolder;
  onEditTitle?: () => void;
}) {
  const t = useTokens();
  const planner = useMemo(() => createPlannerVisualRoles(t), [t]);
  const styles = useMemo(() => makeStyles(t), [t]);

  return (
    <GroupedGlassSheet testID="task-workspace-details-group">
      <View testID="task-workspace-status-row" style={styles.row}>
        <Text style={styles.label}>상태</Text>
        <Text style={[styles.value, { color: planner.statusTone[folderSummary.status] }]}>
          {folderSummary.status}
        </Text>
        {onEditTitle ? (
          <TouchableOpacity
            testID="task-workspace-title-edit-action"
            accessibilityLabel="폴더 제목 편집"
            style={styles.action}
            onPress={onEditTitle}
          >
            <Text style={styles.link}>제목 편집</Text>
          </TouchableOpacity>
        ) : null}
      </View>
      <View testID="task-workspace-assignee-row" style={styles.row}>
        <Text style={styles.label}>담당</Text>
        <Text style={styles.value} numberOfLines={1} ellipsizeMode="tail">
          {folderSummary.assignee || '미지정'}
        </Text>
      </View>
    </GroupedGlassSheet>
  );
}

function makeStyles(t: DesignTokens) {
  const planner = createPlannerVisualRoles(t);
  return StyleSheet.create({
    row: {
      minHeight: planner.minHeight.context,
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.uiSpacing.sm,
      paddingHorizontal: t.cardLayout.padding,
      paddingVertical: t.uiSpacing.sm,
    },
    label: {
      width: planner.statusColumn + planner.contentIconFrame,
      color: t.colors.textSecondary,
      ...planner.typography.meta,
    },
    value: { flex: 1, color: t.colors.textPrimary, ...planner.typography.body },
    action: {
      minWidth: t.hitTarget.min,
      minHeight: t.hitTarget.min,
      alignItems: 'center',
      justifyContent: 'center',
    },
    link: { color: t.colors.accent, ...planner.typography.label },
  });
}
