import { StyleSheet } from 'react-native';
import { createSessionVisualRoles, type DesignTokens } from '../theme';

/** Shared SessionCard and card-row frame; small removes one text row only. */
export function makeSessionCardStyles(t: DesignTokens, embedded: boolean, small = false) {
  const sessionRoles = createSessionVisualRoles(t);
  const AVATAR = sessionRoles.feed.avatar;
  const c = t.colors;
  return StyleSheet.create({
    cardSurface: {
      marginHorizontal: 0,
      marginVertical: embedded ? 0 : t.cardLayout.gap / 2,
    },
    card: {
      ...(!small ? { minHeight: 112 } : {}),
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: sessionRoles.feed.cardPadding,
      paddingVertical: sessionRoles.feed.cardPadding,
      gap: t.uiSpacing.md,
      borderRadius: t.radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: 'transparent',
      // Explicit form of the existing transparent background/no-shadow defaults.
      backgroundColor: 'transparent',
      shadowOpacity: 0,
      overflow: 'hidden',
      elevation: 0,
    },
    avatar: {
      width: AVATAR,
      height: AVATAR,
      borderRadius: AVATAR / 2,
      backgroundColor: c.border,
    },
    avatarFallback: { alignItems: 'center', justifyContent: 'center' },
    avatarFallbackText: {
      color: c.textMuted,
      fontSize: t.fontSize.rowTitle,
      fontWeight: '600',
    },
    content: {
      flex: 1,
      minWidth: 0,
      alignSelf: 'stretch',
      flexDirection: 'row',
    },
    primaryColumn: {
      flex: 1,
      minWidth: 0,
      justifyContent: 'center',
    },
    titleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      minWidth: 0,
    },
    name: {
      ...sessionRoles.typography.title,
      color: c.textPrimary,
      flex: 1,
    },
    rightRail: {
      width: sessionRoles.feed.statusColumn,
      justifyContent: 'space-between',
      alignItems: 'flex-end',
      marginLeft: t.uiSpacing.sm,
    },
    reviewButton: {
      minHeight: sessionRoles.feed.chip.minHeight,
      justifyContent: 'center',
      paddingHorizontal: sessionRoles.feed.chip.paddingHorizontal,
      paddingVertical: sessionRoles.feed.chip.paddingVertical,
      borderRadius: sessionRoles.feed.chip.radius,
      borderWidth: 1,
      borderColor: t.colors.warning,
      backgroundColor: t.colors.warningBg,
    },
    reviewTouchFrame: { alignSelf: 'flex-end' },
    reviewButtonText: {
      color: t.colors.warningText,
      fontSize: t.fontSize.meta,
      fontWeight: '600',
    },
    statusChip: {
      minHeight: sessionRoles.feed.chip.minHeight,
      paddingHorizontal: sessionRoles.feed.chip.paddingHorizontal,
      paddingVertical: sessionRoles.feed.chip.paddingVertical,
      overflow: 'hidden',
      borderRadius: sessionRoles.feed.chip.radius,
      alignItems: 'center',
      justifyContent: 'center',
    },
    statusChipText: {
      fontSize: t.fontSize.meta,
      fontWeight: '600',
    },
    attentionChip: {
      backgroundColor: t.colors.warningBg,
      borderWidth: 1,
      borderColor: t.colors.warning,
    },
    attentionChipText: {
      color: t.colors.warningText,
    },
    identityRow: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      gap: t.uiSpacing.xs,
      minWidth: 0,
    },
    identity: {
      flexShrink: 1,
      minWidth: 0,
      ...sessionRoles.typography.meta,
      color: c.textSecondary,
    },
    contextRow: {
      flexDirection: 'row',
      alignItems: 'center',
      minWidth: 0,
    },
    context: {
      flex: 1,
      minWidth: 0,
      ...sessionRoles.typography.meta,
      color: c.textMuted,
    },
    time: {
      ...sessionRoles.typography.time,
      color: c.textPlaceholder,
    },
  });
}
