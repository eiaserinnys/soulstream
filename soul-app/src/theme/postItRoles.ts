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
  const titleLineHeight = t.foundation.typography.cardTitle.lineHeight;
  const footerHeight = t.hitTarget.min * scale;
  // 푸터 줄은 footerHeight 안에서 이미 세로 가운데 정렬이므로 그 위에 gap을 또 쌓지 않는다.
  // compact는 제목 위 gap을 늘린 만큼 푸터 간격을 좁혀 본문 칸 높이를 회수한다.
  const footerGap = (variant === 'compact' ? t.uiSpacing.xxs : t.uiSpacing.sm) * scale;
  const paddingTop = padding + gap;
  const paddingBottom = padding + footerHeight + footerGap;
  return {
    width: 320 * scale * size, height,
    padding, paddingTop, gap, footerGap, footerHeight, paddingBottom,
    // Initial conservative line count; Text layout uses the actual remaining space.
    bodyLines: Math.floor((height - paddingTop - paddingBottom - titleLineHeight * 2 - gap) / lineHeight),
    title: { ...t.foundation.typography.cardTitle, color: POST_IT_COLORS.textPrimary },
    body: { ...t.foundation.typography.body, color: POST_IT_COLORS.textPrimary },
    label: { ...t.foundation.typography.meta, color: POST_IT_COLORS.textSecondary },
    colors: POST_IT_COLORS, paper: CARD_COLORS[color].hex, radius: t.radius.sm,
  };
}
