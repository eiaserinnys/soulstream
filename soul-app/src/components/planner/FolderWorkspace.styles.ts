import { StyleSheet } from 'react-native';
import { createPlannerVisualRoles, type DesignTokens } from '../../theme';
import { createSurfaceRoles } from '../../theme/surfaceRoles';

export function makeFolderWorkspaceStyles(t: DesignTokens) {
  const roles = createSurfaceRoles(t);
  const planner = createPlannerVisualRoles(t);
  return StyleSheet.create({
    container: { flex: 1, ...roles.canvas.tokenStyle },
    tabletHeader: {
      borderWidth: 0,
      backgroundColor: 'transparent',
    },
    tabletTitle: {
      flex: 1,
      color: t.colors.textPrimary,
      ...planner.typography.navigation,
      padding: 0,
      borderWidth: 0,
      backgroundColor: 'transparent',
    },
    closeButton: {
      minWidth: planner.actionColumn,
      minHeight: planner.actionColumn,
      alignItems: 'center',
      justifyContent: 'center',
    },
    content: { padding: planner.pageInset, gap: t.spacing.lg },
    sectionGroup: { gap: t.spacing.sm },
    topActions: { flexDirection: 'row', alignItems: 'center' },
    empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: planner.pageInset },
    emptyText: { color: t.colors.textTertiary, ...planner.typography.meta },
    error: { color: t.colors.errorText, ...planner.typography.meta },
    title: {
      color: t.colors.textPrimary,
      ...planner.typography.navigation,
      paddingHorizontal: 0,
      paddingVertical: t.uiSpacing.sm,
      borderWidth: 0,
      backgroundColor: 'transparent',
    },
    titleEditor: {
      padding: t.cardLayout.padding,
      gap: t.uiSpacing.sm,
    },
    titleActions: {
      flexDirection: 'row',
      justifyContent: 'flex-end',
      gap: t.uiSpacing.sm,
    },
    metadataAction: {
      minWidth: planner.actionColumn,
      minHeight: planner.actionColumn,
      alignItems: 'center',
      justifyContent: 'center',
    },
    description: {
      minHeight: planner.minHeight.memo,
      color: t.colors.textPrimary,
      ...planner.typography.body,
      padding: t.cardLayout.padding,
      textAlignVertical: 'top',
    },
    primaryAction: { color: t.colors.accent, ...planner.typography.label, paddingVertical: t.spacing.xs },
    secondaryAction: { color: t.colors.textSecondary, ...planner.typography.label },
    link: { color: t.colors.accent, ...planner.typography.label },
    action: {
      minWidth: planner.actionColumn,
      minHeight: planner.actionColumn,
      justifyContent: 'center',
    },
  });
}
