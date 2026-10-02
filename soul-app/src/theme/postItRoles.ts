import type { DesignTokens } from './tokens';
import { LIGHT_COLORS } from './colors';

// Paper is a physical light surface in both themes; glass keeps the active theme.
export const POST_IT_COLORS = LIGHT_COLORS;
export type PostItVariant = 'full' | 'compact';

/** Web/native share the 320:280 paper contract; native keeps its own text and hit tokens. */
export function createPostItRoles(t: DesignTokens, variant: PostItVariant = 'full') {
  const scale = t.chatFontSize.body / 17;
  const size = variant === 'compact' ? 0.8 : 1;
  const height = 280 * scale * size;
  const padding = (variant === 'compact' ? t.cardLayout.padding : t.foundation.pageInset) * scale;
  const gap = t.uiSpacing.sm * scale;
  const lineHeight = 25 * scale;
  return {
    width: 320 * scale * size, height,
    padding, gap, footerHeight: t.hitTarget.min,
    // Initial conservative line count; Text layout uses the actual remaining space.
    bodyLines: Math.floor((height - padding * 2 - t.hitTarget.min - lineHeight * 2 - gap * 2) / lineHeight),
    title: { fontSize: t.chatFontSize.rowTitle, lineHeight: 25 * scale, fontWeight: '600' as const, color: POST_IT_COLORS.textPrimary },
    body: { fontSize: t.chatFontSize.body, lineHeight: 25 * scale, color: POST_IT_COLORS.textPrimary },
    label: { ...t.foundation.typography.meta, fontSize: Math.max(13, 13 * scale), lineHeight: Math.max(20, 20 * scale), color: POST_IT_COLORS.textSecondary },
    colors: POST_IT_COLORS, paper: POST_IT_COLORS.warningBg, radius: t.radius.sm,
  };
}
