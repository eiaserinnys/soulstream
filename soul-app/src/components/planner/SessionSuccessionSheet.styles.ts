import { StyleSheet } from 'react-native';
import type { DesignTokens } from '../../theme';

export function makeStyles(t: DesignTokens) {
  return StyleSheet.create({
    keyboard: { flex: 1 },
    header: {
      minHeight: t.hitTarget.min + t.spacing.sm,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: t.foundation.pageInset,
    },
    headerButton: {
      minWidth: t.hitTarget.min,
      minHeight: t.hitTarget.min,
      justifyContent: 'center',
    },
    headerAction: {
      color: t.colors.accent,
      ...t.foundation.typography.body,
      fontWeight: '700',
    },
    disabled: { color: t.colors.textMuted },
    title: { color: t.colors.textPrimary, ...t.foundation.typography.navigation },
    content: {
      paddingHorizontal: t.foundation.pageInset,
      paddingVertical: t.spacing.lg,
      gap: t.spacing.md,
      paddingBottom: t.spacing.xl,
    },
    folderTitle: { color: t.colors.textPrimary, ...t.foundation.typography.cardTitle },
    sectionTitle: {
      color: t.colors.textPrimary,
      ...t.foundation.typography.section,
      marginTop: t.spacing.xs,
    },
    selectionRow: {
      minHeight: t.foundation.minHeight.field,
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.spacing.sm,
      paddingHorizontal: t.cardLayout.padding,
    },
    fieldLabel: {
      width: 76,
      color: t.colors.textSecondary,
      ...t.foundation.typography.label,
    },
    selectionValue: {
      flex: 1,
      color: t.colors.textPrimary,
      ...t.foundation.typography.body,
      textAlign: 'right',
    },
    warningBadge: {
      alignSelf: 'flex-end',
      color: t.colors.textSecondary,
      ...t.foundation.typography.meta,
      paddingHorizontal: t.cardLayout.padding,
      paddingBottom: t.spacing.xs,
    },
    selectionError: {
      color: t.colors.errorText,
      ...t.foundation.typography.meta,
      paddingHorizontal: t.cardLayout.padding,
      paddingBottom: t.spacing.sm,
    },
    checkRow: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: t.spacing.sm,
      minHeight: t.foundation.hitTarget,
      paddingHorizontal: t.cardLayout.padding,
      paddingVertical: t.spacing.sm,
    },
    check: {
      width: t.iconSize.standard,
      color: t.colors.accent,
      fontSize: t.iconSize.standard,
    },
    checkBody: { flex: 1, gap: t.spacing.xxs },
    rowTitle: { color: t.colors.textPrimary, ...t.foundation.typography.cardTitle },
    meta: { color: t.colors.textTertiary, ...t.foundation.typography.meta },
    formField: { padding: t.spacing.sm, gap: t.spacing.sm },
    initialComposerRow: {
      flexDirection: 'row',
      alignItems: 'flex-end',
      gap: t.spacing.sm,
    },
    initialInput: {
      flex: 1,
      color: t.colors.textPrimary,
      fontSize: t.chatFontSize.body,
      lineHeight: t.chatFontSize.body * t.lineHeightRatio,
      textAlignVertical: 'top',
    },
  });
}
