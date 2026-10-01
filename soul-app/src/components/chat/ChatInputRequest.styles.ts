import { Platform, StyleSheet } from 'react-native';
import type { DesignTokens } from '../../theme';

export function makeChatInputRequestStyles(t: DesignTokens) {
  const typography = t.foundation.typography;
  return StyleSheet.create({
    container: {
      paddingHorizontal: t.spacing.md,
      paddingVertical: t.spacing.xs,
    },
    card: {
      overflow: 'hidden',
      padding: t.uiSpacing.xs,
      gap: t.uiSpacing.sm,
    },
    titleRow: {
      minHeight: t.hitTarget.min,
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.uiSpacing.sm,
      paddingHorizontal: t.uiSpacing.md,
      paddingVertical: t.uiSpacing.sm,
    },
    titleIcon: {
      width: t.iconSize.action,
      height: t.iconSize.action,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: t.foundation.radius.round,
      backgroundColor: t.colors.accentTint,
    },
    titleIconGlyph: {
      ...typography.cardTitle,
      color: t.colors.accent,
    },
    titleCopy: {
      flex: 1,
      gap: t.uiSpacing.xxs,
    },
    eyebrow: {
      ...typography.label,
      color: t.colors.textMuted,
      letterSpacing: 0.8,
    },
    title: {
      ...typography.cardTitle,
      color: t.colors.textPrimary,
    },
    timerText: {
      ...typography.meta,
      color: t.colors.textMuted,
      fontVariant: ['tabular-nums'],
    },
    questionPanel: {
      overflow: 'hidden',
      borderRadius: t.foundation.radius.field,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.colors.border,
      backgroundColor: t.colors.surfaceMuted,
    },
    questionHeader: {
      gap: t.uiSpacing.xs,
      paddingHorizontal: t.uiSpacing.lg,
      paddingTop: t.uiSpacing.md,
      paddingBottom: t.uiSpacing.sm,
    },
    questionMetaRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: t.uiSpacing.sm,
    },
    questionHeaderLabel: {
      ...typography.label,
      color: t.colors.textMuted,
      textTransform: 'uppercase',
      letterSpacing: 0.6,
    },
    questionCount: {
      ...typography.label,
      color: t.colors.textPlaceholder,
      fontVariant: ['tabular-nums'],
    },
    questionText: {
      ...typography.cardTitle,
      color: t.colors.textPrimary,
    },
    selectionHint: {
      ...typography.meta,
      color: t.colors.textMuted,
    },
    optionsGroup: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: t.colors.border,
    },
    optionDivider: {
      height: StyleSheet.hairlineWidth,
      marginLeft:
        t.uiSpacing.md + t.iconSize.prominent + t.uiSpacing.md,
      backgroundColor: t.colors.borderSubtle,
    },
    optionRow: {
      minHeight: t.foundation.minHeight.row,
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: t.uiSpacing.md,
      paddingHorizontal: t.uiSpacing.md,
      paddingVertical: t.uiSpacing.md,
    },
    optionRowActive: {
      backgroundColor: t.colors.accentTint,
    },
    choiceIndicator: {
      width: t.iconSize.prominent,
      height: t.iconSize.prominent,
      marginTop: t.uiSpacing.xxs,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 1,
      borderColor: t.colors.textPlaceholder,
    },
    radioIndicator: {
      borderRadius: t.foundation.radius.round,
    },
    checkboxIndicator: {
      borderRadius: t.foundation.radius.chip,
    },
    choiceIndicatorSelected: {
      borderColor: t.colors.accent,
      backgroundColor: t.colors.accent,
    },
    radioDot: {
      width: t.uiSpacing.sm,
      height: t.uiSpacing.sm,
      borderRadius: t.foundation.radius.round,
      backgroundColor: t.colors.accentText,
    },
    checkmark: {
      fontSize: t.iconSize.prominent,
      lineHeight: t.iconSize.prominent,
      fontWeight: '700',
      color: t.colors.accentText,
    },
    optionCopy: {
      flex: 1,
      gap: t.uiSpacing.xs,
    },
    optionLabel: {
      ...typography.body,
      fontWeight: '600',
      color: t.colors.textPrimary,
    },
    optionDescription: {
      ...typography.meta,
      color: t.colors.textSecondary,
    },
    previewViewport: {
      maxWidth: '100%',
      marginTop: t.uiSpacing.xs,
      borderRadius: t.foundation.radius.chip,
      backgroundColor: t.colors.surfaceCode,
    },
    previewContent: {
      paddingHorizontal: t.uiSpacing.sm,
      paddingVertical: t.uiSpacing.sm,
    },
    previewText: {
      ...typography.mono,
      color: t.colors.codeText,
      fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    },
    footer: {
      gap: t.uiSpacing.sm,
      paddingHorizontal: t.uiSpacing.sm,
      paddingBottom: t.uiSpacing.sm,
    },
    submitButton: {
      width: '100%',
    },
    submitButtonText: {
      ...typography.body,
      fontWeight: '600',
      color: t.colors.accentText,
    },
    submittingRow: {
      minHeight: t.hitTarget.min,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: t.uiSpacing.sm,
    },
    submittingText: {
      ...typography.meta,
      color: t.colors.textMuted,
    },
    errorText: {
      ...typography.meta,
      paddingHorizontal: t.uiSpacing.md,
      paddingVertical: t.uiSpacing.sm,
      borderRadius: t.foundation.radius.field,
      color: t.colors.errorText,
      backgroundColor: t.colors.errorBg,
    },
    statusPanel: {
      gap: t.uiSpacing.xs,
      paddingHorizontal: t.uiSpacing.lg,
      paddingVertical: t.uiSpacing.md,
    },
    statusText: {
      ...typography.body,
      fontWeight: '600',
      color: t.colors.textMuted,
    },
    doneText: {
      ...typography.body,
      fontWeight: '600',
      color: t.colors.successText,
    },
    statusDescription: {
      ...typography.meta,
      color: t.colors.textMuted,
    },
  });
}
