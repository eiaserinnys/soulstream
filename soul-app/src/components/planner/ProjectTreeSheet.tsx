import React, { useMemo } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { Folder } from '../../api/types';
import { splitPlannerProjectLabel, type PlannerProjectTreeRow } from '../../lib/planner-project-tree';
import { createPlannerVisualRoles, useTokens, type DesignTokens } from '../../theme';
import { DisclosureIcon } from '../DisclosureIcon';
import { GroupedGlassRow, GroupedGlassSheet } from './GroupedGlassSheet';

export function ProjectTreeSheet({
  rows,
  activeProjectPageId,
  onToggle,
  onOpen,
  onLongPress,
  onManage,
  onSelectFolder,
}: {
  rows: readonly PlannerProjectTreeRow[];
  activeProjectPageId?: string | null;
  onToggle: (folderId: string) => void;
  onOpen: (folder: Folder, projectPageId: string) => void;
  onLongPress: (folder: Folder, projectPageId: string) => void;
  onSelectFolder?: (folder: Folder) => void;
  onManage?: (folder: Folder, projectPageId: string) => void;
}) {
  const t = useTokens();
  const planner = useMemo(() => createPlannerVisualRoles(t), [t]);
  const styles = useMemo(() => makeStyles(t), [t]);

  if (rows.length === 0) return null;
  return (
    <GroupedGlassSheet surface="inherited" testID="project-tree-sheet">
      {rows.map((treeRow) => {
        const { folder } = treeRow;
        const projectPageId = folder.projectPageId;
        const label = splitPlannerProjectLabel(folder.name);
        return (
          <GroupedGlassRow
            key={folder.id}
            testID={`project-card-content-${folder.id}`}
            style={styles.row}
            accessibilityLabel={folder.name}
            selected={projectPageId === activeProjectPageId}
            disabled={!projectPageId && !onSelectFolder}
            onPress={() => onSelectFolder ? onSelectFolder(folder) : projectPageId && onOpen(folder, projectPageId)}
            onLongPress={() => projectPageId && onLongPress(folder, projectPageId)}
          >
            <View
              testID={`project-row-inner-${folder.id}`}
              style={[styles.rowInner, { paddingLeft: treeRow.depth * planner.projectIndent }]}
            >
              <View testID={`project-disclosure-slot-${folder.id}`} style={styles.disclosureSlot}>
                {treeRow.hasChildren ? (
                  <TouchableOpacity
                    testID={`project-disclosure-${folder.id}`}
                    accessibilityLabel={`${folder.name} ${treeRow.isExpanded ? '접기' : '펼치기'}`}
                    accessibilityState={{ expanded: treeRow.isExpanded }}
                    style={styles.disclosureAction}
                    onPress={(event) => {
                      event?.stopPropagation?.();
                      onToggle(folder.id);
                    }}
                  >
                    <DisclosureIcon
                      expanded={treeRow.isExpanded}
                      color={t.colors.textMuted}
                      size={planner.disclosureVisual}
                    />
                  </TouchableOpacity>
                ) : null}
              </View>
              <View testID={`project-leading-${folder.id}`} style={styles.leading}>
                {label.emoji ? (
                  <Text style={styles.contentEmoji}>{label.emoji}</Text>
                ) : (
                  <Ionicons
                    name={projectPageId || onSelectFolder ? 'folder-outline' : 'warning-outline'}
                    color={projectPageId || onSelectFolder ? t.colors.textMuted : t.colors.warning}
                    size={t.iconSize.prominent}
                  />
                )}
              </View>
              <View testID={`project-title-column-${folder.id}`} style={styles.rowText}>
                <Text style={styles.title} numberOfLines={1} ellipsizeMode="tail">
                  {label.title}
                </Text>
                {!projectPageId && !onSelectFolder ? (
                  <Text style={styles.missing} numberOfLines={1}>
                    프로젝트 페이지 연결이 필요합니다.
                  </Text>
                ) : null}
              </View>
              {projectPageId && onManage ? (
                <TouchableOpacity
                  testID={`project-menu-${folder.id}`}
                  accessibilityLabel={`${folder.name} 관리`}
                  style={styles.action}
                  onPress={(event) => {
                    event?.stopPropagation?.();
                    onManage(folder, projectPageId);
                  }}
                >
                  <Text style={styles.manage}>•••</Text>
                </TouchableOpacity>
              ) : <View style={styles.action} />}
              <View testID={`project-chevron-${folder.id}`} style={styles.chevronFrame}>
                {projectPageId || onSelectFolder ? <Text style={styles.chevron}>›</Text> : null}
              </View>
            </View>
          </GroupedGlassRow>
        );
      })}
    </GroupedGlassSheet>
  );
}

function makeStyles(t: DesignTokens) {
  const planner = createPlannerVisualRoles(t);
  return StyleSheet.create({
    row: {
      minHeight: planner.minHeight.row,
      paddingHorizontal: t.uiSpacing.md,
      paddingVertical: t.uiSpacing.sm,
    },
    rowInner: {
      flex: 1,
      minWidth: 0,
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.uiSpacing.sm,
    },
    disclosureSlot: {
      width: planner.disclosureVisual,
      height: planner.contentIconFrame,
      alignItems: 'center',
      justifyContent: 'center',
    },
    disclosureAction: {
      position: 'absolute',
      left: (planner.disclosureVisual - planner.actionColumn) / 2,
      top: (planner.contentIconFrame - planner.actionColumn) / 2,
      width: planner.actionColumn,
      height: planner.actionColumn,
      alignItems: 'center',
      justifyContent: 'center',
    },
    leading: {
      width: planner.contentIconFrame,
      height: planner.contentIconFrame,
      alignItems: 'center',
      justifyContent: 'center',
    },
    contentEmoji: { ...planner.typography.body },
    rowText: { flex: 1 },
    title: { color: t.colors.textPrimary, ...planner.typography.cardTitle },
    missing: { color: t.colors.warningText, ...planner.typography.meta },
    action: {
      minHeight: planner.actionColumn,
      minWidth: planner.actionColumn,
      alignItems: 'center',
      justifyContent: 'center',
    },
    manage: { color: t.colors.textTertiary, ...planner.typography.body, padding: t.spacing.sm },
    chevronFrame: {
      width: planner.contentIconFrame,
      height: planner.contentIconFrame,
      alignItems: 'center',
      justifyContent: 'center',
    },
    chevron: { color: t.colors.textMuted, fontSize: t.iconSize.standard },
  });
}
