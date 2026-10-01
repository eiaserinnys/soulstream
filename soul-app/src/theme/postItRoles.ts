import type { DesignTokens } from './tokens';
export type PostItVariant = 'full' | 'compact';

/** Web/native share the 320:280 paper contract; native keeps its own text and hit tokens. */
export function createPostItRoles(t: DesignTokens, variant: PostItVariant = 'full') {
  const scale = t.chatFontSize.body / 17;
  const size = variant === 'compact' ? 0.8 : 1;
  return {
    width: 320 * scale * size, height: 280 * scale * size,
    padding: (variant === 'compact' ? t.cardLayout.padding : t.foundation.pageInset) * scale,
    gap: t.uiSpacing.sm * scale, footerHeight: t.hitTarget.min,
    bodyLines: variant === 'compact' ? 2 : 4,
    title: { fontSize: t.chatFontSize.rowTitle, lineHeight: 25 * scale, fontWeight: '600' as const, color: t.colors.textPrimary },
    body: { fontSize: t.chatFontSize.body, lineHeight: 25 * scale, color: t.colors.textPrimary },
    label: { ...t.foundation.typography.meta, fontSize: Math.max(13, 13 * scale), lineHeight: Math.max(20, 20 * scale), color: t.colors.textSecondary },
    paper: t.colors.warningBg, radius: t.radius.sm,
  };
}
