import React, { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { CompactTouchTarget } from '../CompactTouchTarget';
import { useTokens, type DesignTokens } from '../../theme';
import type { TurnSummaryRenderItem, TurnUsageCaption } from './groupChatEvents';
import {
  CollapsibleCaptionBody,
  CollapsibleCaptionHeader,
  CollapsibleCaptionLine,
} from './CollapsibleCaption';

interface Props {
  usage?: TurnUsageCaption;
  summaries?: TurnSummaryRenderItem[];
}

export function TurnEndCaptions({ usage, summaries }: Props) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);
  const [usageExpanded, setUsageExpanded] = useState(false);
  const [summaryExpanded, setSummaryExpanded] = useState(false);

  if (!usage && !summaries?.length) return null;

  return (
    <View testID="turn-end-captions" style={styles.wrapper}>
      <View style={styles.contentStack}>
        <View testID="turn-end-captions-heads" style={styles.heads}>
          {usage ? (
            <CaptionHeadButton
              title={usage.title}
              expandedTitle={usage.expandedTitle}
              expanded={usageExpanded}
              titleCanShrink={false}
              onToggle={() => setUsageExpanded((value) => !value)}
            />
          ) : null}
          {summaries?.length ? (
            <CaptionHeadButton
              title="요약"
              contentWidth={t.chatFontSize.meta * 2 + t.iconSize.compact + t.uiSpacing.sm * 3}
              expanded={summaryExpanded}
              onToggle={() => setSummaryExpanded((value) => !value)}
            />
          ) : null}
        </View>
        {usageExpanded && usage ? (
          <CollapsibleCaptionBody align="end" alignmentInset="content">
            {usage.lines.map((line, index) => (
              <CollapsibleCaptionLine key={`${usage.title}-${index}`} wrap>
                {line}
              </CollapsibleCaptionLine>
            ))}
          </CollapsibleCaptionBody>
        ) : null}
        {summaryExpanded && summaries?.length ? (
          <CollapsibleCaptionBody align="end" alignmentInset="content">
            {summaries.map((summary) => (
              <CollapsibleCaptionLine key={summary.key} wrap>
                {summary.content}
              </CollapsibleCaptionLine>
            ))}
          </CollapsibleCaptionBody>
        ) : null}
      </View>
    </View>
  );
}

function CaptionHeadButton({
  title,
  expandedTitle,
  contentWidth,
  expanded,
  titleCanShrink,
  onToggle,
}: {
  title: string;
  expandedTitle?: string;
  contentWidth?: number;
  expanded: boolean;
  titleCanShrink?: boolean;
  onToggle(): void;
}) {
  const [pressed, setPressed] = useState(false);
  const contentWidthStyle = contentWidth ? { width: contentWidth } : undefined;
  return (
    <CompactTouchTarget
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ expanded }}
      onPress={onToggle}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      activeOpacity={1}
      frameStyle={[{ maxWidth: '100%', flexShrink: 0 }, contentWidthStyle]}
      surfaceStyle={[{ alignSelf: 'flex-end', maxWidth: '100%' }, contentWidth ? { width: '100%' } : undefined]}
    >
      <CollapsibleCaptionHeader
        title={title}
        expandedTitle={expandedTitle}
        expanded={expanded}
        titleCanShrink={titleCanShrink}
        pressed={pressed}
        align="end"
        alignmentInset="content"
      />
    </CompactTouchTarget>
  );
}

function makeStyles(t: DesignTokens) {
  return StyleSheet.create({
    wrapper: {
      width: '100%',
      paddingHorizontal: 0,
    },
    contentStack: {
      width: '100%',
      alignItems: 'flex-end',
      gap: t.uiSpacing.xxs,
    },
    heads: {
      width: '100%',
      flexDirection: 'row',
      flexWrap: 'wrap',
      alignItems: 'center',
      justifyContent: 'flex-end',
      gap: t.spacing.md,
    },
  });
}
