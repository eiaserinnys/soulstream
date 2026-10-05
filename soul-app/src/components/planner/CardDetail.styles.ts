import { StyleSheet } from 'react-native';
import type { DesignTokens } from '../../theme';

export function cardDetailStyles(t: DesignTokens) {
  const type = t.foundation.typography;
  const s = t.uiSpacing;
  const sendNoticeSurfaceHeight = t.controlHeight.chip + s.xs + s.xxs;
  return StyleSheet.create({
    container: { flex: 1 },
    frame: { flex: 1, minHeight: 0 },
    header: { paddingHorizontal: t.foundation.pageInset, paddingVertical: s.md, gap: s.sm },
    headerRow: { flexDirection: 'row', alignItems: 'center', gap: s.sm },
    titleHitFrame: { flex: 1, minWidth: 0, alignSelf: 'stretch', alignItems: 'stretch', justifyContent: 'center' },
    titleHitSurface: { flex: 1, minWidth: 0, alignItems: 'flex-start', justifyContent: 'center' },
    heading: { flex: 1, minWidth: 0, ...type.section, color: t.colors.textPrimary },
    chips: { flex: 1, minWidth: 0, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: s.xs },
    chip: { minHeight: t.controlHeight.chip, paddingHorizontal: s.sm, borderRadius: t.foundation.radius.round, backgroundColor: t.colors.surfaceCode, flexDirection: 'row', alignItems: 'center', gap: s.xs, maxWidth: '100%' },
    chipAvatar: { width: t.avatarSize.compact, height: t.avatarSize.compact, borderRadius: t.foundation.radius.round },
    chipText: { ...type.meta, color: t.colors.textSecondary, flexShrink: 1, fontWeight: '600' },
    nowWrap: { paddingHorizontal: t.foundation.pageInset, marginBottom: s.sm },
    tabsWrap: { paddingHorizontal: t.foundation.pageInset, marginBottom: s.sm },
    bodyFrame: { flex: 1, minHeight: 0 },
    content: { flexGrow: 1, paddingHorizontal: t.foundation.pageInset, paddingBottom: 0, gap: s.lg },
    dock: { position: 'absolute', left: t.foundation.pageInset, right: t.foundation.pageInset, gap: s.xs },
    sendNotice: { minHeight: t.hitTarget.min, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: s.sm },
    sendNoticeSurface: { flex: 1, height: sendNoticeSurfaceHeight,
      borderWidth: StyleSheet.hairlineWidth, borderRadius: t.foundation.radius.round,
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      gap: s.sm, paddingHorizontal: s.sm },
    sendNoticeText: { ...type.meta, color: t.colors.textSecondary },
    empty: { ...type.body, color: t.colors.textSecondary },
    sessions: { gap: t.cardLayout.gap },
    timeline: { gap: s.sm },
    kindRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: s.sm, marginBottom: s.xs },
    kind: { ...type.meta, fontWeight: '700' },
    meta: { ...type.meta, color: t.colors.textSecondary },
    body: { fontSize: t.chatFontSize.body, lineHeight: t.chatFontSize.body * t.lineHeightRatio, color: t.colors.textPrimary },
    bodyStack: {},
    commentTarget: { ...type.meta, color: t.colors.textSecondary, fontWeight: '500', marginBottom: s.xs },
    reportBodyStack: { gap: s.sm, width: '100%', alignSelf: 'stretch', alignItems: 'flex-start' },
    link: { ...type.body, color: t.colors.accent },
    option: { minHeight: t.controlHeight.chip, justifyContent: 'center' },
    thumbnails: { flexDirection: 'row', flexWrap: 'wrap', gap: s.sm },
    error: { ...type.body, color: t.colors.errorText },
  });
}
