import React from 'react';
import { View } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { EnrichedMarkdownText } from 'react-native-enriched-markdown';
import { createAssistantMarkdownStyle } from '../../theme/assistantMarkdownStyle';
import { createPlannerVisualRoles, useTokens, type DesignTokens } from '../../theme';

export function PlannerMarkdownText({
  markdown,
  testID,
  variant = 'planner',
  textAlign,
}: {
  markdown: string;
  testID?: string;
  variant?: 'planner' | 'card' | 'note';
  textAlign?: 'left';
}) {
  const t = useTokens();
  const markdownStyle = variant === 'card' ? cardMarkdownStyle(t) : plannerMarkdownStyle(t, variant === 'note');
  const alignedStyle = textAlign ? {
    ...markdownStyle,
    paragraph: { ...markdownStyle.paragraph, textAlign },
    h1: { ...markdownStyle.h1, textAlign },
    h2: { ...markdownStyle.h2, textAlign },
    h3: { ...markdownStyle.h3, textAlign },
  } : markdownStyle;
  return (
    <View testID={testID} style={textAlign ? { width: '100%', alignSelf: 'stretch' } : undefined}>
      <EnrichedMarkdownText
        markdown={markdown}
        flavor="github"
        markdownStyle={alignedStyle}
        containerStyle={textAlign ? { width: '100%', textAlign } : undefined}
        selectable
        onLinkPress={({ url }) => { void WebBrowser.openBrowserAsync(url); }}
      />
    </View>
  );
}

export function plannerMarkdownStyle(t: DesignTokens, note = false) {
  const c = t.colors;
  const textColor = note ? c.textSecondary : c.textPrimary;
  const planner = createPlannerVisualRoles(t);
  return {
    paragraph: {
      color: textColor,
      ...planner.typography.body,
    },
    h1: { color: textColor, ...planner.typography.display },
    h2: { color: textColor, ...planner.typography.section },
    h3: { color: textColor, ...planner.typography.cardTitle },
    strong: { color: textColor, fontWeight: '700' },
    em: { color: textColor, fontStyle: 'italic' },
    link: { color: c.link },
    code: { backgroundColor: c.surfaceCode, color: c.codeText, fontFamily: 'Courier' },
    codeBlock: {
      backgroundColor: c.surfaceCode,
      color: textColor,
      fontFamily: 'Courier',
      padding: t.uiSpacing.sm,
      borderRadius: t.radius.sm,
    },
    blockquote: {
      color: c.textSecondary,
      backgroundColor: c.surfaceCode,
      borderColor: c.accent,
      borderWidth: 3,
      gapWidth: 8,
    },
    list: {
      color: textColor,
      ...planner.typography.body,
      bulletColor: c.textMuted,
      markerColor: c.textMuted,
    },
  } as any;
}

function cardMarkdownStyle(t: DesignTokens) {
  const heading = { color: t.colors.textPrimary, ...createPlannerVisualRoles(t).typography.cardTitle };
  return { ...createAssistantMarkdownStyle(t), h1: heading, h2: heading, h3: heading };
}
