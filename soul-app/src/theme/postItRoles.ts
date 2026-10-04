import type { DesignTokens } from './tokens';
import { LIGHT_COLORS } from './colors';
import { CARD_COLORS, type CardColor } from '../../../packages/wire-schema/src/card_colors';

// Paper is a physical light surface in both themes; glass keeps the active theme.
export const POST_IT_COLORS = LIGHT_COLORS;
export type PostItVariant = 'full' | 'compact';

/** Web/native share the 320:280 paper contract; native keeps its own text and hit tokens. */
export function createPostItRoles(t: DesignTokens, variant: PostItVariant = 'full', color: CardColor = 'yellow') {
  const scale = t.foundation.typography.body.fontSize / 17;
  const size = variant === 'compact' ? 0.8 : 1;
  const height = 280 * scale * size;
  const padding = (variant === 'compact' ? t.cardLayout.padding : t.foundation.pageInset) * scale;
  const gap = t.uiSpacing.sm * scale;
  const lineHeight = t.foundation.typography.body.lineHeight;
  const footerHeight = t.hitTarget.min * scale;
  return {
    width: 320 * scale * size, height,
    padding, gap, footerHeight,
    // Initial conservative line count; Text layout uses the actual remaining space.
    bodyLines: Math.floor((height - padding * 2 - footerHeight - lineHeight * 2 - gap * 2) / lineHeight),
    title: { ...t.foundation.typography.cardTitle, color: POST_IT_COLORS.textPrimary },
    body: { ...t.foundation.typography.body, color: POST_IT_COLORS.textPrimary },
    label: { ...t.foundation.typography.meta, color: POST_IT_COLORS.textSecondary },
    colors: POST_IT_COLORS, paper: CARD_COLORS[color].hex, radius: t.radius.sm,
  };
}
