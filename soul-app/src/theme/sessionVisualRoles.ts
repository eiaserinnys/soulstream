import type { DesignTokens } from './tokens';

export function createSessionVisualRoles(t: DesignTokens) {
  return {
    feed: {
      pageInset: t.foundation.pageInset,
      cardPadding: 16,
      avatar: 44,
      statusColumn: 76,
      chip: {
        minHeight: 24,
        paddingHorizontal: t.uiSpacing.sm,
        paddingVertical: 0,
        radius: t.foundation.radius.chip,
      },
    },
    typography: {
      title: t.foundation.typography.cardTitle,
      meta: t.foundation.typography.meta,
      time: t.foundation.typography.label,
    },
    chat: {
      body: t.chatFontSize.body,
      messageGap: 12,
      bubblePaddingHorizontal: 16,
      bubblePaddingVertical: 14,
      bubbleMaxWidth: '86%' as const,
      attachment: {
        assistantMaxWidth: 360,
        userMaxWidth: 320,
        phoneAssistantMaxWidth: '100%' as const,
        phoneUserMaxWidth: '88%' as const,
        thumbnailFrameSize: { width: 200, height: 200 },
        radius: 10,
        filenameGap: 6,
        gridGap: t.uiSpacing.md,
        metadata: t.foundation.typography.meta,
        textMuted: t.colors.textMuted,
        surface: t.colors.surface,
        border: t.colors.border,
      },
      tool: {
        visualMinHeight: t.foundation.minHeight.tool,
        fontSize: 13,
        lineHeight: 18,
        stateIconSize: 17,
        chevronSize: 14,
        paddingHorizontal: 12,
        paddingVertical: 6,
        gap: 6,
        rowGap: 6,
        bodyPadding: 12,
        codeFontSize: 13,
        codeLineHeight: 19,
      },
      composer: {
        minHeight: t.foundation.minHeight.composer,
        contentMinHeight: t.foundation.minHeight.secondary,
        edgePaddingHorizontal: 6,
        edgePaddingVertical: 4,
        controlGap: 6,
        inputPaddingHorizontal: 8,
        inputPaddingVertical: 10,
        controlVisualSize: 40,
        hitTarget: t.foundation.hitTarget,
      },
    },
  } as const;
}

export type SessionVisualRoles = ReturnType<typeof createSessionVisualRoles>;
