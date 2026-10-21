import type { MarkdownStyle } from 'react-native-enriched-markdown';
import type { DesignTokens } from './tokens';

export function markdownTableStyle(t: DesignTokens) {
  const c = t.colors;
  return {
    color: c.textPrimary,
    borderColor: c.border,
    borderWidth: 1,
    borderRadius: t.radius.sm,
    headerBackgroundColor: c.surfaceCode,
    headerTextColor: c.textPrimary,
    rowEvenBackgroundColor: c.surface,
    rowOddBackgroundColor: c.surface,
    cellPaddingHorizontal: t.spacing.sm,
    cellPaddingVertical: t.spacing.sm,
  };
}

export function createAssistantMarkdownStyle(t: DesignTokens, narration = false): MarkdownStyle {
  const c = t.colors;
  const narrationColor = narration ? c.textSecondary : c.textPrimary;
  const narrationFontSize = narration ? t.chatFontSize.meta : t.chatFontSize.body;
  return {
      paragraph: {
        fontSize: narrationFontSize,
        color: narrationColor,
        lineHeight: narrationFontSize * t.lineHeightRatio,
        marginTop: t.spacing.xxs,
        marginBottom: t.spacing.xxs,
      },
      h1: { color: narrationColor, fontSize: narration ? narrationFontSize : t.chatFontSize.screenTitle, fontWeight: '700' },
      h2: { color: narrationColor, fontSize: narration ? narrationFontSize : t.chatFontSize.rowTitle, fontWeight: '700' },
      h3: { color: narrationColor, fontSize: narrationFontSize, fontWeight: '700' },
      h4: { color: narrationColor, fontSize: narrationFontSize, fontWeight: '700' },
      h5: { color: narrationColor, fontSize: narrationFontSize, fontWeight: '700' },
      h6: { color: narrationColor, fontSize: narrationFontSize, fontWeight: '700' },
      strong: { color: narrationColor, fontWeight: '700' },
      em: { color: narrationColor, fontStyle: 'italic' as const },
      link: { color: c.link },
      code: {
        backgroundColor: c.surfaceCode,
        color: c.codeText,
        borderColor: c.border,
        fontFamily: 'Courier',
        fontSize: t.fontSize.body,
      },
      codeBlock: {
        backgroundColor: c.surfaceCode,
        color: c.textPrimary,
        fontFamily: 'Courier',
        fontSize: t.fontSize.body,
        padding: t.spacing.sm,
        borderRadius: t.radius.sm,
        borderColor: c.accent,
        borderWidth: 0,
        marginTop: t.spacing.sm,
        marginBottom: t.spacing.sm,
      },
      blockquote: {
        color: c.textSecondary,
        backgroundColor: c.surfaceCode,
        borderColor: c.accent,
        borderWidth: 3,
        gapWidth: 8,
      },
      list: {
        color: narrationColor,
        fontSize: narrationFontSize,
        lineHeight: narrationFontSize * t.lineHeightRatio,
        bulletColor: c.textMuted,
        markerColor: c.textMuted,
      },
      // Shared table contract: the body text is explicit because the library default is dark gray.
      table: markdownTableStyle(t),
      thematicBreak: { color: c.border },
    } as any; // 기존 채팅의 네이티브 스타일 값과 타입 허용 범위를 그대로 보존한다.
}
