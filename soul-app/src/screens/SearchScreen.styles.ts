import { StyleSheet } from 'react-native';
import type { DesignTokens } from '../theme';
import { createSurfaceRoles } from '../theme/surfaceRoles';

export function makeSearchScreenStyles(t: DesignTokens) {
  const roles = createSurfaceRoles(t);
  return StyleSheet.create({
    container: { flex: 1, ...roles.canvas.tokenStyle },
    content: {
      flexGrow: 1,
      paddingHorizontal: t.foundation.pageInset,
      paddingVertical: t.spacing.md,
      gap: t.cardLayout.gap,
    },
    header: { gap: t.spacing.md, marginBottom: t.spacing.md },
    tabletSearchActions: {
      minHeight: t.hitTarget.min,
      flexDirection: 'row',
      alignItems: 'center',
    },
    tabletSearchLabel: {
      flex: 1,
      color: t.colors.textPrimary,
      ...t.foundation.typography.cardTitle,
    },
    filterAction: {
      minWidth: t.hitTarget.min,
      minHeight: t.hitTarget.min,
      alignItems: 'center',
      justifyContent: 'center',
    },
    filterActionActive: {
      borderColor: t.colors.accent,
    },
    heading: {
      color: t.colors.textPrimary,
      ...t.foundation.typography.section,
      paddingTop: t.spacing.lg,
      paddingBottom: t.spacing.xs,
    },
    selected: {
      borderWidth: 1,
      borderColor: t.colors.accent,
      borderRadius: t.radius.lg,
    },
    navigationRow: {
      minHeight: t.hitTarget.min,
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.spacing.sm,
      paddingHorizontal: t.spacing.md,
    },
    navigationKind: {
      // This is the only badge before a navigation title. Message badges follow
      // their title, while SessionCard is a separate result layout.
      width: 64,
      flexShrink: 0,
      textAlign: 'center',
      color: t.colors.textMuted,
      ...t.foundation.typography.label,
    },
    navigationTitle: {
      flex: 1,
      color: t.colors.textPrimary,
      ...t.foundation.typography.body,
    },
    sessionResultDetails: {
      gap: t.spacing.xs,
      paddingHorizontal: t.spacing.md,
      paddingBottom: t.spacing.sm,
    },
    sessionResultExcerpt: {
      color: t.colors.textSecondary,
      ...t.foundation.typography.body,
    },
    sessionResultFolder: {
      color: t.colors.textMuted,
      ...t.foundation.typography.label,
    },
    searchPartialStatus: {
      color: t.colors.textMuted,
      ...t.foundation.typography.label,
    },
    loading: { padding: t.spacing.xl },
    more: {
      minHeight: t.foundation.minHeight.primary,
      alignItems: 'center',
      justifyContent: 'center',
      marginVertical: t.spacing.lg,
    },
    moreText: {
      color: t.colors.accent,
      ...t.foundation.typography.body,
      fontWeight: '600',
    },
    empty: {
      flex: 1,
      minHeight: 300,
      alignItems: 'center',
      justifyContent: 'center',
      padding: t.spacing.xl,
      gap: t.spacing.sm,
    },
    emptyTitle: {
      color: t.colors.textPrimary,
      ...t.foundation.typography.section,
      textAlign: 'center',
    },
    emptyDetail: {
      color: t.colors.textMuted,
      ...t.foundation.typography.body,
      textAlign: 'center',
    },
    recents: { gap: t.spacing.sm },
    wrap: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: t.spacing.sm,
    },
    recentChip: {
      minHeight: t.hitTarget.min,
      justifyContent: 'center',
      paddingHorizontal: t.spacing.md,
    },
    recentText: {
      color: t.colors.textSecondary,
      ...t.foundation.typography.body,
    },
    muted: {
      color: t.colors.textMuted,
      ...t.foundation.typography.body,
    },
  });
}
