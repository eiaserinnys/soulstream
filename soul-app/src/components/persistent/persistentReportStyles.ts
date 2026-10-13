import { StyleSheet } from 'react-native';
import { createPrimitiveRoles, createSessionVisualRoles, type DesignTokens } from '../../theme';

/** Existing tablet rows: 12 + 22 + 8 + 2*22 + 12 + 3*(48+2) + 2*4 + 48 + 8 + 16 + 2 = 330.
 * Title, two body lines, three paper buttons and their gaps, navigation, padding and surface borders. */
export function minimumReportBubbleHeight(t: DesignTokens) {
  return t.uiSpacing.md + t.foundation.typography.cardTitle.lineHeight + t.uiSpacing.sm
    + 2 * t.foundation.typography.body.lineHeight + t.uiSpacing.md
    + 3 * (Math.max(t.hitTarget.min, t.foundation.minHeight.secondary) + 2 * StyleSheet.hairlineWidth)
    + 2 * t.uiSpacing.xs + t.hitTarget.min + t.uiSpacing.sm + t.uiSpacing.lg + 2 * StyleSheet.hairlineWidth;
}
export function reportStyles(t: DesignTokens, _bleed: number, showNav: boolean) {
  const type = t.foundation.typography, chip = createSessionVisualRoles(t).feed.chip;
  const iconOverhang = (t.hitTarget.min - t.foundation.iconFrame.compact) / 2;
  return StyleSheet.create({
    deck: { backgroundColor: t.persistentSession.panel, borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.persistentSession.line, borderRadius: t.foundation.radius.card, overflow: 'hidden' },
    band: { marginVertical: t.uiSpacing.sm },
    track: { alignItems: 'stretch' },
    sheet: { flexGrow: 1 },
    resting: { cursor: 'auto' },
    body: { paddingTop: t.uiSpacing.md, paddingHorizontal: t.uiSpacing.lg },
    reading: { gap: t.uiSpacing.sm },
    heading: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: t.uiSpacing.sm, rowGap: t.uiSpacing.xs },
    title: { ...type.cardTitle, color: t.colors.textPrimary, flexShrink: 1 },
    chipSlot: { height: chip.minHeight, justifyContent: 'center' },
    chipFrame: { marginVertical: -(t.hitTarget.min - chip.minHeight) / 2 },
    chipSurface: { minHeight: chip.minHeight, paddingHorizontal: chip.paddingHorizontal, borderRadius: chip.radius,
      backgroundColor: t.colors.surfaceCode, borderWidth: StyleSheet.hairlineWidth, borderColor: t.colors.border },
    chipContents: { flexDirection: 'row', alignItems: 'center', gap: t.uiSpacing.xxs },
    cardNumber: { ...type.meta, color: t.colors.link, fontWeight: '600', fontVariant: ['tabular-nums'] },
    context: { ...type.body, color: t.colors.textSecondary },
    todo: { ...type.body, color: t.colors.textPrimary },
    link: { color: t.colors.link },
    receivedLabel: { ...type.meta, color: t.colors.textSecondary },
    foot: { flexDirection: 'row', flexWrap: 'wrap-reverse', alignItems: 'center', columnGap: t.uiSpacing.sm,
      rowGap: t.uiSpacing.sm, paddingHorizontal: t.uiSpacing.lg, paddingTop: t.uiSpacing.md, paddingBottom: t.uiSpacing.lg },
    navSlot: { width: showNav ? t.hitTarget.min * 2 + t.uiSpacing.xxl + t.uiSpacing.xs * 2 - iconOverhang : t.uiSpacing.xxl,
      height: showNav ? t.hitTarget.min : type.meta.lineHeight },
    nav: { position: 'absolute', left: t.uiSpacing.lg - (showNav ? iconOverhang : 0), bottom: t.uiSpacing.lg,
      flexDirection: 'row', alignItems: 'center', gap: t.uiSpacing.xs },
    count: { ...type.meta, color: t.colors.textMuted, fontVariant: ['tabular-nums'], minWidth: t.uiSpacing.xxl, textAlign: 'center' },
    page: { ...type.meta, color: t.colors.textMuted, fontVariant: ['tabular-nums'], alignSelf: 'flex-start', marginTop: 'auto' },
    actions: { marginLeft: 'auto', flexShrink: 1, flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end',
      columnGap: t.uiSpacing.sm, rowGap: t.uiSpacing.xs },
    button: { maxWidth: '100%' },
    buttonLabel: { ...type.body, color: t.colors.textPrimary },
    received: { flexBasis: 0, flexGrow: 1, flexShrink: 1, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center',
      justifyContent: 'flex-end', columnGap: t.uiSpacing.sm },
    cancelLabel: { ...type.meta, color: t.colors.textSecondary },
    cancelEdge: { marginRight: -createPrimitiveRoles(t).buttonSecondary.padding.horizontal },
    compact: { gap: t.uiSpacing.sm, paddingBottom: t.uiSpacing.lg },
    scroll: { flexGrow: 1, flexShrink: 1, minHeight: 0 },
    more: { position: 'absolute', left: 0, right: 0, bottom: 0, height: StyleSheet.hairlineWidth, backgroundColor: t.persistentSession.line },
  });
}
