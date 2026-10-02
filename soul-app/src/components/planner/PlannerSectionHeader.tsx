import React, { useMemo } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { createPlannerVisualRoles, useTokens, type DesignTokens } from '../../theme';
import { DisclosureIcon } from '../DisclosureIcon';

export function PlannerSectionHeader({
  title,
  count,
  testID,
  countTestID,
  countSuffix,
  variant = 'default',
  actionLabel,
  onAction,
  extraAction,
  expanded,
  onToggle,
  disclosureFrameTestID,
}: {
  title: string;
  count?: number;
  testID?: string;
  countTestID?: string;
  countSuffix?: string;
  variant?: 'default' | 'board' | 'lane';
  actionLabel?: string;
  onAction?: () => void;
  extraAction?: { label: string; onPress(): void };
  expanded?: boolean;
  onToggle?: () => void;
  disclosureFrameTestID?: string;
}) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);
  const board = variant === 'board';
  if (variant === 'lane') return <Text testID={testID} numberOfLines={1} accessibilityRole="header" style={styles.title}>
    {title + ' '}<Text testID={countTestID}>{`${count ?? 0}${countSuffix??'개'}`}</Text>
  </Text>;
  if (onToggle) return (
    <TouchableOpacity testID={testID} accessibilityRole="button"
      accessibilityLabel={`${title} ${expanded ? '접기' : '펼치기'}`}
      accessibilityState={{ expanded }} style={[styles.row, count !== undefined && styles.countedRow]} onPress={onToggle}>
      <Text style={[styles.title, count !== undefined && styles.countedTitle]}>{title}</Text>
      {count !== undefined ? <Text testID={countTestID} style={styles.count}>{count}{countSuffix}</Text> : null}
      <View testID={disclosureFrameTestID} style={styles.disclosureFrame}>
        <DisclosureIcon expanded={expanded === true} color={t.colors.textMuted} size={t.iconSize.compact} />
      </View>
    </TouchableOpacity>
  );
  return (
    <View testID={testID} style={[styles.row, count !== undefined && styles.countedRow, board && styles.boardRow]}>
      <Text numberOfLines={board ? 1 : undefined} style={[styles.title, count !== undefined && styles.countedTitle, board && styles.boardTitle]}>{title}</Text>
      {count !== undefined ? <Text testID={countTestID} style={styles.count}>{count}{countSuffix}</Text> : null}
      {onAction && actionLabel ? (
        <TouchableOpacity accessibilityRole="button" style={styles.action} onPress={onAction}>
          <Text style={styles.link}>{actionLabel}</Text>
        </TouchableOpacity>
      ) : null}
      {extraAction ? (
        <TouchableOpacity accessibilityRole="button" style={styles.action} onPress={extraAction.onPress}>
          <Text style={styles.link}>{extraAction.label}</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

function makeStyles(t: DesignTokens) {
  const planner = createPlannerVisualRoles(t);
  return StyleSheet.create({
    row: { minHeight: planner.minHeight.context, flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm },
    title: { color: t.colors.textPrimary, ...planner.typography.section, flex: 1 },
    countedRow: { alignItems: 'baseline', gap: t.uiSpacing.sm },
    countedTitle: { flex: 0, flexShrink: 1 },
    boardTitle: { flexBasis: 'auto' },
    boardRow: { minHeight: planner.typography.section.lineHeight },
    count: { color: t.colors.textSecondary, ...planner.typography.meta, marginRight: 'auto' },
    disclosureFrame: { width: planner.actionColumn, height: planner.actionColumn, alignItems: 'center', justifyContent: 'center' },
    action: { minWidth: planner.actionColumn, minHeight: planner.actionColumn, justifyContent: 'center', alignItems: 'center' },
    link: { color: t.colors.accent, ...planner.typography.label },
  });
}
