import { StyleSheet } from 'react-native';
import type { DesignTokens } from '../../theme';
import { createSurfaceRoles } from '../../theme/surfaceRoles';
import { createSessionVisualRoles } from '../../theme/sessionVisualRoles';

export function makeStyles(t: DesignTokens) {
  const c = t.colors;
  const roles = createSurfaceRoles(t);
  const sessionRoles = createSessionVisualRoles(t);
  return StyleSheet.create({
    container: { flex: 1, ...roles.canvas.tokenStyle },
    list: { flex: 1 },
    listContent: { paddingVertical: t.spacing.md },
    footerLoader: { paddingVertical: t.spacing.lg, alignItems: 'center' },
    errorText: {
      color: c.errorText,
      fontSize: t.chatFontSize.meta,
      textAlign: 'center',
      paddingVertical: t.spacing.xs,
    },
    offlineNotice: {
      color: c.warningText,
      fontSize: t.chatFontSize.meta,
      lineHeight: t.chatFontSize.meta * t.lineHeightRatio,
      textAlign: 'center',
      paddingHorizontal: t.foundation.pageInset,
      paddingVertical: t.spacing.xs,
    },
    inputRow: {
      paddingHorizontal: t.spacing.md,
      paddingVertical: t.spacing.sm,
    },
    composerBox: {
      minHeight: sessionRoles.chat.composer.minHeight,
      borderRadius: t.radius.lg + 6,
      paddingHorizontal: sessionRoles.chat.composer.edgePaddingHorizontal,
      paddingVertical: sessionRoles.chat.composer.edgePaddingVertical - StyleSheet.hairlineWidth,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
    },
    composerContentRow: {
      minHeight: sessionRoles.chat.composer.contentMinHeight,
      flexDirection: 'column',
    },
    composerControlsRow: {
      minHeight: sessionRoles.chat.composer.hitTarget,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    composerRightControls: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: sessionRoles.chat.composer.controlGap,
    },
    composerControlFrame: {
      flexShrink: 0,
    },
    composerSecondaryControl: {
      width: sessionRoles.chat.composer.controlVisualSize,
      height: sessionRoles.chat.composer.controlVisualSize,
      borderRadius: sessionRoles.chat.composer.controlVisualSize / 2,
      backgroundColor: 'transparent',
    },
    composerControlDisabled: {
      opacity: 0.45,
    },
    stopBtn: {
      width: sessionRoles.chat.composer.controlVisualSize,
      height: sessionRoles.chat.composer.controlVisualSize,
      borderRadius: sessionRoles.chat.composer.controlVisualSize / 2,
      backgroundColor: c.error,
      justifyContent: 'center',
      alignItems: 'center',
    },
    stopBtnDisabled: {
      opacity: 0.55,
    },
    attachmentRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: t.spacing.sm,
      paddingHorizontal: t.spacing.md,
      paddingTop: t.spacing.xs,
    },
    attachmentTouchFrame: {
      minHeight: t.hitTarget.min,
      maxWidth: '70%',
      justifyContent: 'center',
      position: 'relative',
    },
    attachmentChip: {
      flexDirection: 'row',
      alignItems: 'center',
      height: t.controlHeight.chip,
      gap: t.spacing.xs,
      backgroundColor: c.surfaceMuted,
      borderRadius: t.radius.sm,
      paddingHorizontal: t.spacing.sm,
      maxWidth: '100%',
    },
    attachmentRemoveSpacer: { width: t.hitTarget.min },
    attachmentRemoveFrame: { position: 'absolute', right: 0, top: 0 },
    attachmentRemove: {
      width: t.controlHeight.chip,
      height: t.controlHeight.chip,
      alignItems: 'center',
      justifyContent: 'center',
    },
    attachmentName: {
      color: c.textSecondary,
      fontSize: t.chatFontSize.meta,
      flexShrink: 1,
    },
    composerTextInput: {
      color: c.textPrimary,
      minHeight: sessionRoles.chat.composer.contentMinHeight,
      maxHeight: 128,
      paddingHorizontal: sessionRoles.chat.composer.inputPaddingHorizontal,
      paddingVertical: sessionRoles.chat.composer.inputPaddingVertical,
      fontSize: t.chatFontSize.body,
      lineHeight: t.chatFontSize.body * t.lineHeightRatio,
    },
    voiceSlot: {
      minHeight: sessionRoles.chat.composer.hitTarget,
      flexShrink: 0,
      justifyContent: 'center',
    },
    sendBtn: {
      width: sessionRoles.chat.composer.controlVisualSize,
      height: sessionRoles.chat.composer.controlVisualSize,
      borderRadius: sessionRoles.chat.composer.controlVisualSize / 2,
      backgroundColor: c.accent,
      justifyContent: 'center',
      alignItems: 'center',
    },
    sendBtnDisabled: {
      backgroundColor: c.surfaceMuted,
      borderWidth: 1,
      borderColor: c.border,
    },
    emptyState: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      padding: t.spacing.xxl,
    },
    emptyIcon: { fontSize: t.iconSize.hero, marginBottom: t.spacing.md },
    emptyTitle: {
      fontSize: t.chatFontSize.screenTitle,
      fontWeight: '600',
      color: c.textPrimary,
      marginBottom: t.spacing.sm,
      textAlign: 'center',
    },
    emptyDesc: {
      fontSize: t.chatFontSize.body,
      color: c.textMuted,
      textAlign: 'center',
      lineHeight: t.chatFontSize.body * t.lineHeightRatio,
    },
  });
}

export type ChatBodyStyles = ReturnType<typeof makeStyles>;
