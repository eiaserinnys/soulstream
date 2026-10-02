import { StyleSheet } from 'react-native';
import type { DesignTokens } from '../../theme';

export function cardDetailStyles(t: DesignTokens) {
  const type = t.foundation.typography;
  const s = t.uiSpacing;
  return StyleSheet.create({
    container: { flex: 1 },
    header: { paddingHorizontal: t.foundation.pageInset, paddingVertical: s.md, gap: s.sm },
    headerRow: { flexDirection: 'row', alignItems: 'center', gap: s.sm },
    heading: { flex: 1, minWidth: 0, ...type.navigation, color: t.colors.textPrimary },
    glyph: { ...type.body, color: t.colors.textPrimary },
    chips: { flex: 1, minWidth: 0, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: s.xs },
    chip: { minHeight: t.controlHeight.chip, paddingHorizontal: s.sm, borderRadius: t.foundation.radius.round, backgroundColor: t.colors.surfaceCode, flexDirection: 'row', alignItems: 'center', gap: s.xs, maxWidth: '100%' },
    chipAvatar: { width: t.avatarSize.compact, height: t.avatarSize.compact, borderRadius: t.foundation.radius.round },
    chipText: { ...type.meta, color: t.colors.textSecondary, flexShrink: 1, fontWeight: '600' },
    done: { minHeight: t.foundation.iconFrame.compact, justifyContent: 'center' },
    doneText: { ...type.body, color: t.colors.accent, fontWeight: '600' },
    disabled: { opacity: 0.45 },
    content: { paddingHorizontal: t.foundation.pageInset, paddingBottom: s.lg, gap: s.lg },
    sessions: { gap: t.cardLayout.gap },
    timeline: { gap: s.sm },
    kindRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: s.sm, marginBottom: s.xs },
    kind: { ...type.meta, fontWeight: '700' },
    meta: { ...type.meta, color: t.colors.textSecondary },
    body: { fontSize: t.chatFontSize.body, lineHeight: t.chatFontSize.body * t.lineHeightRatio, color: t.colors.textPrimary },
    bodyStack: {},
    reportBodyStack: { gap: s.sm, width: '100%', alignSelf: 'stretch', alignItems: 'flex-start' },
    link: { ...type.body, color: t.colors.accent },
    option: { minHeight: t.controlHeight.chip, justifyContent: 'center' },
    thumbnails: { flexDirection: 'row', flexWrap: 'wrap', gap: s.sm },
    error: { ...type.body, color: t.colors.errorText },
  });
}
