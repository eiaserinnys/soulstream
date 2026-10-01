import { StyleSheet } from 'react-native';
import type { DesignTokens } from '../../theme';

// HistoryFetchError 컴포넌트 스타일. ChatBody.styles.ts의 footerLoader와 같은 padding
// 패턴(spacing.lg)을 차용하여 spinner ↔ ErrorBox 전환 시 layout shift 최소화.
//
// 색상 의도:
// - container: 별 background 없음 (FlatList contentContainerStyle 위에 inline)
// - message: textSecondary — 조용한 에러 표현 (HistoryFetchError.tsx 코멘트 참조)
// - retryBtn: surface + border (subtle) + accent text — primary action affordance

export function makeHistoryFetchErrorStyles(t: DesignTokens) {
  return StyleSheet.create({
    container: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: t.spacing.sm,
      paddingVertical: t.spacing.lg,
      paddingHorizontal: t.spacing.md,
    },
    message: {
      color: t.colors.textSecondary,
      fontSize: t.chatFontSize.body,
    },
    retryBtn: {
      minHeight: t.hitTarget.min,
      justifyContent: 'center',
      paddingHorizontal: t.spacing.md,
      paddingVertical: t.spacing.xs,
      borderRadius: t.radius.sm,
      borderWidth: 1,
      borderColor: t.colors.border,
      backgroundColor: t.colors.surface,
    },
    retryText: {
      color: t.colors.accent,
      fontSize: t.chatFontSize.body,
      fontWeight: '600',
    },
  });
}
