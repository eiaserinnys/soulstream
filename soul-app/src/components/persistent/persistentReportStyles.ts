import { StyleSheet } from 'react-native';
import type { DesignTokens } from '../../theme';

export function reportStyles(t: DesignTokens, bleed: number, showNav: boolean) {
  const type = t.foundation.typography;
  // 제목줄의 아이콘 단추와 같은 맞춤: 누름 틀이 아니라 아이콘 틀의 끝을 칸의 오른쪽 선에 맞춘다.
  const iconOverhang = (t.hitTarget.min - t.foundation.iconFrame.compact) / 2;
  return StyleSheet.create({
    deck: { marginHorizontal: -bleed },
    track: { alignItems: 'stretch' },
    // 장은 가장 긴 장의 높이까지 늘어나고, 단추는 늘 아래 끝에 선다.
    sheet: { flexGrow: 1, paddingHorizontal: bleed, paddingTop: t.uiSpacing.md, paddingBottom: t.uiSpacing.lg, gap: t.uiSpacing.md, justifyContent: 'space-between' },
    // 누름을 받지 않는 온 장은 손가락 모양 커서를 보이지 않는다(RN웹과 포인터가 있는 기기).
    resting: { cursor: 'auto' },
    reading: { gap: t.uiSpacing.sm },
    heading: { gap: t.uiSpacing.xs },
    tagRow: { flexDirection: 'row', alignItems: showNav ? 'center' : 'baseline', gap: t.uiSpacing.sm, minHeight: showNav ? t.hitTarget.min : undefined },
    // 단추 둘과 「n / N」이 서는 자리를 비운다.
    tagRowWithNav: { paddingRight: t.hitTarget.min * 2 + t.uiSpacing.xxl + t.uiSpacing.xs * 2 - iconOverhang },
    nav: { position: 'absolute', top: t.uiSpacing.md, right: bleed - iconOverhang, flexDirection: 'row', alignItems: 'center', gap: t.uiSpacing.xs },
    // 「n / N」은 다른 장이 있음을 알리는 글이라 대비 4.5:1을 넘는 textMuted를 쓴다(textPlaceholder는 어두운 칸 위에서 4.3:1).
    count: { ...type.meta, color: t.colors.textMuted, fontVariant: ['tabular-nums'], minWidth: t.uiSpacing.xxl, textAlign: 'center' },
    kind: { ...type.meta, fontWeight: '700' },
    kindAsk: { color: t.colors.warningText },
    kindQuiet: { color: t.colors.textSecondary },
    cardNumber: { ...type.meta, color: t.colors.link, fontVariant: ['tabular-nums'] },
    page: { ...type.meta, color: t.colors.textMuted, fontVariant: ['tabular-nums'], marginLeft: 'auto' },
    title: { ...type.cardTitle, color: t.colors.textPrimary },
    context: { ...type.body, color: t.colors.textSecondary },
    todo: { ...type.body, color: t.colors.textPrimary },
    link: { color: t.colors.link },
    receivedLabel: { ...type.meta, color: t.colors.textSecondary },
    actions: { flexDirection: 'row', flexWrap: 'wrap', gap: t.uiSpacing.sm },
    button: { maxWidth: '100%' },
    buttonLabel: { ...type.body, color: t.colors.textPrimary, flexShrink: 1 },
  });
}
