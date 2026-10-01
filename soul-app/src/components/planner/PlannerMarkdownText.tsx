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
}: {
  markdown: string;
  testID?: string;
  variant?: 'planner' | 'card';
}) {
  const t = useTokens();
  return (
    <View testID={testID}>
      <EnrichedMarkdownText
        markdown={markdown}
        flavor="github"
        markdownStyle={variant === 'card' ? cardMarkdownStyle(t) : plannerMarkdownStyle(t)}
        selectable
        onLinkPress={({ url }) => { void WebBrowser.openBrowserAsync(url); }}
      />
    </View>
  );
}

export function plannerMarkdownStyle(t: DesignTokens) {
  const c = t.colors;
  const planner = createPlannerVisualRoles(t);
  return {
    paragraph: {
      color: c.textPrimary,
      ...planner.typography.body,
    },
    h1: { color: c.textPrimary, ...planner.typography.display },
    h2: { color: c.textPrimary, ...planner.typography.section },
    h3: { color: c.textPrimary, ...planner.typography.cardTitle },
    strong: { color: c.textPrimary, fontWeight: '700' },
    em: { color: c.textPrimary, fontStyle: 'italic' },
    link: { color: c.link },
    code: { backgroundColor: c.surfaceCode, color: c.codeText, fontFamily: 'Courier' },
    codeBlock: {
      backgroundColor: c.surfaceCode,
      color: c.textPrimary,
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
      color: c.textPrimary,
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
