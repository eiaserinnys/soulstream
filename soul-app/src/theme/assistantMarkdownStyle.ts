import type { MarkdownStyle } from 'react-native-enriched-markdown';
import type { DesignTokens } from './tokens';

export function createAssistantMarkdownStyle(t: DesignTokens): MarkdownStyle {
  const c = t.colors;
  return {
      paragraph: {
        fontSize: t.chatFontSize.body,
        color: c.textPrimary,
        lineHeight: t.chatFontSize.body * t.lineHeightRatio,
        marginTop: t.spacing.xxs,
        marginBottom: t.spacing.xxs,
      },
      h1: { color: c.textPrimary, fontSize: t.chatFontSize.screenTitle, fontWeight: '700' },
      h2: { color: c.textPrimary, fontSize: t.chatFontSize.rowTitle, fontWeight: '700' },
      h3: { color: c.textPrimary, fontSize: t.chatFontSize.body, fontWeight: '700' },
      strong: { color: c.textPrimary, fontWeight: '700' },
      em: { color: c.textPrimary, fontStyle: 'italic' as const },
      link: { color: c.link },
      code: {
        backgroundColor: c.surfaceCode,
        color: c.codeText,
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
        color: c.textPrimary,
        fontSize: t.chatFontSize.body,
        lineHeight: t.chatFontSize.body * t.lineHeightRatio,
        bulletColor: c.textMuted,
        markerColor: c.textMuted,
      },
      // react-native-enriched-markdown TableStyle (BaseBlockStyle 상속).
      // 다크모드에서 표가 배경과 구분되지 않던 결함 해소: 헤더 배경/텍스트, 테두리,
      // 셀 패딩을 토큰 기반으로 명시. zebra(짝/홀 색차)는 셀 보더로 충분하다고 판단하여
      // 동일 색상으로 비활성.
      // color: BaseBlockStyle.color로 셀 본문 텍스트 색을 명시 — 미지정 시 라이브러리
      // 기본값(어두운 회색)으로 떨어져 다크모드에서 가독성 결함이 보고됨 (사용자 보고).
      table: {
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
      },
    } as any; // 기존 채팅의 네이티브 스타일 값과 타입 허용 범위를 그대로 보존한다.
}
