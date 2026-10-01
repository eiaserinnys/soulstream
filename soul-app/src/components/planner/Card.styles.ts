import { StyleSheet } from 'react-native';
import { createPlannerVisualRoles, type DesignTokens } from '../../theme';

export function cardStyles(t: DesignTokens) {
  const planner = createPlannerVisualRoles(t);
  return StyleSheet.create({
    content: { paddingHorizontal: planner.pageInset, paddingVertical: t.uiSpacing.lg, gap: planner.sectionRhythm.before },
    groups: { gap: planner.sectionRhythm.before },
    section: { gap: planner.sectionRhythm.after },
    statusAction: { alignSelf: 'flex-start', minWidth: t.hitTarget.min, minHeight: t.hitTarget.min, justifyContent: 'center' },
    reportHeader: { flexDirection: 'row', alignItems: 'center', gap: t.uiSpacing.sm, minHeight: planner.minHeight.context },
    disclosureFrame: { width: planner.actionColumn, height: planner.actionColumn, alignItems: 'center', justifyContent: 'center' },
    padded: { padding: t.cardLayout.padding, gap: t.uiSpacing.sm },
    row: { flexDirection: 'row', alignItems: 'center', gap: t.uiSpacing.sm, minHeight: planner.minHeight.row },
    copy: { flex: 1, minWidth: 0, minHeight: t.hitTarget.min, gap: t.uiSpacing.xs },
    title: { color: t.colors.textPrimary, ...planner.typography.cardTitle },
    heading: { color: t.colors.textPrimary, ...planner.typography.navigation },
    body: { color: t.colors.textPrimary, ...planner.typography.body },
    meta: { color: t.colors.textSecondary, ...planner.typography.meta },
    chip: { borderRadius: t.foundation.radius.chip, backgroundColor: t.colors.surfaceCode,
      paddingHorizontal: t.uiSpacing.sm, paddingVertical: t.uiSpacing.xs, alignSelf: 'flex-start' },
    label: { color: t.colors.textPrimary, ...planner.typography.label },
    actionText: { color: t.colors.accent, ...planner.typography.body },
    input: { minHeight: planner.minHeight.context, borderRadius: t.foundation.radius.field,
      paddingHorizontal: t.uiSpacing.md, paddingVertical: t.uiSpacing.sm,
      backgroundColor: t.colors.surfaceCode, color: t.colors.textPrimary, ...planner.typography.body },
    actions: { flexDirection: 'row', alignItems: 'center', gap: t.uiSpacing.sm },
    error: { color: t.colors.errorText, ...planner.typography.body },
  });
}
