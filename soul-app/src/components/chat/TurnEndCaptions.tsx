import React, { useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { CompactTouchTarget } from '../CompactTouchTarget';
import type { PersistentTurnUsageMode } from '../../api/persistentSessionEndpoints';
import { useTokens, type DesignTokens } from '../../theme';
import type {
  PersistentInstructionRecordedCaption,
  TurnSummaryRenderItem,
  TurnUsageCaption,
} from './groupChatEvents';
import {
  CollapsibleCaptionBody,
  CollapsibleCaptionHeader,
  CollapsibleCaptionLine,
} from './CollapsibleCaption';

interface Props {
  usage?: TurnUsageCaption;
  turnUsageMode?: PersistentTurnUsageMode;
  summaries?: TurnSummaryRenderItem[];
  persistentInstructionRecorded?: PersistentInstructionRecordedCaption;
}

export function TurnEndCaptions({ usage, turnUsageMode = 'collapsed', summaries, persistentInstructionRecorded }: Props) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);
  const [usageExpanded, setUsageExpanded] = useState(turnUsageMode === 'expanded');
  const [summaryExpanded, setSummaryExpanded] = useState(false);
  const [instructionRecordedExpanded, setInstructionRecordedExpanded] = useState(false);
  useEffect(() => setUsageExpanded(turnUsageMode === 'expanded'), [turnUsageMode]);
  const hasRecordedInstructions = Boolean(
    persistentInstructionRecorded
    && (persistentInstructionRecorded.instructions.length > 0 || persistentInstructionRecorded.capReached),
  );

  if (!usage && !summaries?.length && !hasRecordedInstructions) return null;

  const instructionRecordedTitle = persistentInstructionRecorded?.instructions.length
    ? '📌 지속 지시로 기록했습니다'
    : '📌 지속 지시 상한에 닿았습니다';

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
              expanded={summaryExpanded}
              onToggle={() => setSummaryExpanded((value) => !value)}
            />
          ) : null}
          {hasRecordedInstructions ? (
            <CaptionHeadButton
              title={instructionRecordedTitle}
              expanded={instructionRecordedExpanded}
              onToggle={() => setInstructionRecordedExpanded((value) => !value)}
            />
          ) : null}
        </View>
        {((usageExpanded && usage)
          || (summaryExpanded && summaries?.length)
          || (instructionRecordedExpanded && hasRecordedInstructions)) ? (
          <View testID="turn-end-captions-bodies" style={styles.bodies}>
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
            {instructionRecordedExpanded && hasRecordedInstructions && persistentInstructionRecorded ? (
              <CollapsibleCaptionBody align="end" alignmentInset="content">
                {persistentInstructionRecorded.instructions.map((instruction) => {
                  const sourceTurns = instruction.source_turns.join(', ');
                  return (
                    <CollapsibleCaptionLine key={instruction.id} wrap>
                      {sourceTurns ? `${instruction.text} (${sourceTurns})` : instruction.text}
                    </CollapsibleCaptionLine>
                  );
                })}
                {persistentInstructionRecorded.capReached ? (
                  <CollapsibleCaptionLine key="persistent-instruction-cap" wrap>
                    상한(50)에 닿아 더 기록하지 못했습니다
                  </CollapsibleCaptionLine>
                ) : null}
              </CollapsibleCaptionBody>
            ) : null}
          </View>
        ) : null}
      </View>
    </View>
  );
}

function CaptionHeadButton({
  title,
  expandedTitle,
  expanded,
  titleCanShrink,
  onToggle,
}: {
  title: string;
  expandedTitle?: string;
  expanded: boolean;
  titleCanShrink?: boolean;
  onToggle(): void;
}) {
  const [pressed, setPressed] = useState(false);
  return (
    <CompactTouchTarget
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ expanded }}
      onPress={onToggle}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      activeOpacity={1}
      frameStyle={{ maxWidth: '100%', flexShrink: 0 }}
      surfaceStyle={{ alignSelf: 'flex-end', maxWidth: '100%' }}
    >
      <CollapsibleCaptionHeader
        title={title}
        expandedTitle={expandedTitle}
        expanded={expanded}
        alignTrailingEdge
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
    bodies: {
      width: '100%',
      alignItems: 'flex-end',
      gap: t.uiSpacing.sm,
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
