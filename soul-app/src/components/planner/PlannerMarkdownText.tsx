import React from 'react';
import type { AttachmentReadContext } from '../../../../packages/wire-schema/src/attachments';
import { View } from 'react-native';
import { EnrichedMarkdownText } from 'react-native-enriched-markdown';
import { createAssistantMarkdownStyle, markdownTableStyle } from '../../theme/assistantMarkdownStyle';
import { createPlannerVisualRoles, useTokens, type DesignTokens } from '../../theme';
import { useOpenContentLink } from '../../hooks/useOpenContentLink';
import { CopyableBlockquote, CopyableCodeBlock } from '../events/CopyableAssistantMarkdown';
import { segmentMarkdownBlockquotes } from '../events/blockquoteCopyModel';

export function PlannerMarkdownText({
  markdown,
  testID,
  variant = 'planner',
  textAlign,
  readContext,
}: {
  markdown: string;
  testID?: string;
  variant?: 'planner' | 'card' | 'note';
  textAlign?: 'left';
  readContext?: AttachmentReadContext;
}) {
  const t = useTokens();
  const openContentLink = useOpenContentLink(readContext);
  const markdownStyle = variant === 'card' ? cardMarkdownStyle(t) : plannerMarkdownStyle(t, variant === 'note');
  const alignedStyle = textAlign ? {
    ...markdownStyle,
    paragraph: { ...markdownStyle.paragraph, textAlign },
    h1: { ...markdownStyle.h1, textAlign },
    h2: { ...markdownStyle.h2, textAlign },
    h3: { ...markdownStyle.h3, textAlign },
  } : markdownStyle;
  const segments = segmentMarkdownBlockquotes(markdown);
  const renderMarkdown = (value: string, segmentIndex?: number) => (
    <EnrichedMarkdownText
      {...(segmentIndex === undefined ? {} : { testID: `planner-markdown-segment-${segmentIndex}` })}
      markdown={value}
      flavor="github"
      markdownStyle={alignedStyle}
      containerStyle={textAlign ? { width: '100%', textAlign } : undefined}
      selectable
      onLinkPress={({ url }) => { void openContentLink(url); }}
    />
  );
  let quoteIndex = 0;
  let codeBlockIndex = 0;
  return (
    <View testID={testID} style={textAlign ? { width: '100%', alignSelf: 'stretch' } : undefined}>
      {segments.length === 1 && segments[0].kind === 'markdown'
        ? renderMarkdown(segments[0].markdown)
        : segments.map((segment, index) => {
          if (segment.kind === 'blockquote') {
            const currentQuoteIndex = quoteIndex;
            quoteIndex += 1;
            return <CopyableBlockquote
              key={`blockquote-${currentQuoteIndex}`}
              index={currentQuoteIndex}
              markdown={segment.markdown}
              plainText={segment.plainText}
              markdownStyle={alignedStyle as any}
              onLinkPress={({ url }) => { void openContentLink(url); }}
            />;
          }
          if (segment.kind === 'codeBlock') {
            const currentCodeBlockIndex = codeBlockIndex;
            codeBlockIndex += 1;
            return <CopyableCodeBlock
              key={`codeblock-${currentCodeBlockIndex}`}
              index={currentCodeBlockIndex}
              markdown={segment.markdown}
              copyText={segment.copyText}
              markdownStyle={alignedStyle as any}
              onLinkPress={({ url }) => { void openContentLink(url); }}
              selectable
            />;
          }
          return <React.Fragment key={`markdown-${index}`}>
            {renderMarkdown(segment.markdown, index)}
          </React.Fragment>;
        })}
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
    h4: { color: textColor, ...planner.typography.body, fontWeight: '700' },
    h5: { color: textColor, ...planner.typography.body, fontWeight: '700' },
    h6: { color: textColor, ...planner.typography.body, fontWeight: '700' },
    strong: { color: textColor, fontWeight: '700' },
    em: { color: textColor, fontStyle: 'italic' },
    link: { color: c.link },
    code: { backgroundColor: c.surfaceCode, color: c.codeText, fontFamily: 'Courier', borderColor: c.border },
    codeBlock: {
      backgroundColor: c.surfaceCode,
      color: textColor,
      fontFamily: 'Courier',
      padding: t.uiSpacing.sm,
      borderRadius: t.radius.sm,
      borderColor: c.accent,
      borderWidth: 0,
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
    taskList: { checkedTextColor: textColor },
    table: markdownTableStyle(t),
    thematicBreak: { color: c.border },
  } as any;
}

function cardMarkdownStyle(t: DesignTokens) {
  const heading = { color: t.colors.textPrimary, ...createPlannerVisualRoles(t).typography.cardTitle };
  return { ...createAssistantMarkdownStyle(t), h1: heading, h2: heading, h3: heading };
}
