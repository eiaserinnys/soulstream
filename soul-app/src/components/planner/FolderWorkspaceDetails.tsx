import React, { useMemo } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import type { ApiClient } from '../../api/client';
import type { PlannerFolder } from '../../api/plannerTypes';
import type {
  PlannerDefaultAssignment,
  PlannerSourcedContext,
} from '../../lib/planner-context-presentation';
import { createPlannerVisualRoles, useTokens, type DesignTokens } from '../../theme';
import { GroupedGlassSheet } from './GroupedGlassSheet';
import { FolderDefaultAssignment } from './FolderDefaultAssignment';

export function FolderWorkspaceDetails({
  api,
  folderSummary,
  contexts,
  assignment,
  onEditTitle,
  onSaveAssignment,
}: {
  api: ApiClient | null;
  folderSummary: PlannerFolder;
  contexts: readonly PlannerSourcedContext[];
  assignment: PlannerDefaultAssignment | null;
  onEditTitle?: () => void;
  onSaveAssignment(value: {
    agentId: string;
    nodeId: string;
    modelPreset?: string;
  }): Promise<void>;
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
      <View testID="task-workspace-context-row" style={styles.row}>
        <Text style={styles.label}>컨텍스트</Text>
        <View style={styles.contextBody}>
          {contexts.length === 0 ? (
            <View testID="task-workspace-context-empty" style={styles.emptyContext}>
              <Text style={styles.emptyText}>컨텍스트 없음</Text>
              <View
                testID="task-workspace-add-context"
                style={styles.action}
                accessible
                accessibilityRole="button"
                accessibilityLabel="컨텍스트 추가"
                accessibilityState={{ disabled: true }}
              >
                <Text style={styles.disabledAction}>＋ 추가</Text>
              </View>
            </View>
          ) : contexts.map((item) => {
            const content = (
              <>
                <View style={styles.iconFrame}>
                  <Text style={styles.icon}>{item.icon}</Text>
                </View>
                <View style={styles.contextCopy}>
                  <Text style={styles.contextTitle} numberOfLines={1} ellipsizeMode="tail">
                    {item.kind === 'atom' ? 'atom · ' : ''}{item.label}
                  </Text>
                  <Text style={styles.source} numberOfLines={1} ellipsizeMode="tail">
                    {item.sourceLabel}
                  </Text>
                </View>
              </>
            );
            return (
              <View
                key={`${item.sourceLabel}:${item.id}`}
                testID={`task-workspace-context-item-${item.id}`}
                style={styles.contextItem}
              >
                {content}
              </View>
            );
          })}
        </View>
      </View>
      <View testID="task-workspace-default-assignment-row" style={styles.row}>
        <Text style={styles.label}>기본 담당</Text>
        <View style={styles.assignmentBody}>
          <FolderDefaultAssignment
            api={api}
            agentId={assignment?.agentId ?? null}
            nodeId={assignment?.nodeId ?? null}
            modelPreset={assignment?.modelPreset ?? null}
            sourceLabel={assignment?.sourceLabel ?? '직접 지정'}
            onSave={onSaveAssignment}
          />
        </View>
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
    contextBody: { flex: 1, gap: t.uiSpacing.xs },
    emptyContext: {
      minHeight: planner.minHeight.context,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: t.uiSpacing.sm,
    },
    emptyText: { flex: 1, color: t.colors.textTertiary, ...planner.typography.body },
    disabledAction: { color: t.colors.textDisabled, ...planner.typography.label },
    contextItem: {
      minHeight: planner.minHeight.context,
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.uiSpacing.sm,
    },
    iconFrame: {
      width: planner.contentIconFrame,
      height: planner.contentIconFrame,
      alignItems: 'center',
      justifyContent: 'center',
    },
    icon: { ...planner.typography.body },
    contextCopy: { flex: 1, gap: t.uiSpacing.xxs },
    contextTitle: { color: t.colors.textPrimary, ...planner.typography.body },
    source: { color: t.colors.textTertiary, ...planner.typography.meta },
    assignmentBody: { flex: 1 },
  });
}
