import React, { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { CardDto } from '../../api/cardTypes';
import { useOpenContentLink } from '../../hooks/useOpenContentLink';
import { REPORT_TIMELINE_STATUS_LABEL, type ReportTimelineLine } from '../../../../packages/wire-schema/src/persistent_report';
import { useTokens, type DesignTokens } from '../../theme';
import { CardStatusChip } from '../planner/CardRow';
import { getChatRowHorizontalInset } from './ChatBody.styles';

interface Props {
  line: ReportTimelineLine;
  presentation?: 'default' | 'manuscript';
  onOpenCard?: (cardId: string) => void;
}

function statusCard(line: ReportTimelineLine): CardDto {
  const status = line.status === 'question' ? 'blocked'
    : line.status === 'on_hold' || line.status === 'report' ? 'todo'
      : line.status;
  return {
    id: line.card_id ?? line.line_key,
    status,
    blockedKind: line.status === 'question' ? 'question' : null,
  } as CardDto;
}

export function ReportTimelineRow({ line, presentation = 'default', onOpenCard }: Props) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t, presentation), [t, presentation]);
  const openContentLink = useOpenContentLink();
  const card = statusCard(line);
  const content = <>
    <View style={styles.badge}>
      <CardStatusChip card={card} detail label={REPORT_TIMELINE_STATUS_LABEL[line.status]} />
    </View>
    <View style={styles.textGroup}>
      {line.card_number !== null ? <Text style={styles.number} numberOfLines={1}>#{line.card_number}</Text> : null}
      <Text style={styles.title} numberOfLines={1}>{line.title}</Text>
      {line.detail ? <Text style={styles.detail} numberOfLines={1}>{line.detail}</Text> : null}
    </View>
  </>;

  if (!line.card_id) return <View style={styles.row}>{content}</View>;
  return <Pressable
    accessibilityRole="link"
    accessibilityLabel={`#${line.card_number ?? ''} ${line.title}`.trim()}
    onPress={() => onOpenCard ? onOpenCard(line.card_id!) : openContentLink(`/?card=${encodeURIComponent(line.card_id!)}`)}
    style={({ pressed }) => [styles.row, pressed ? styles.pressed : undefined]}
  >{content}</Pressable>;
}

function makeStyles(t: DesignTokens, presentation: 'default' | 'manuscript') {
  const captionLine = Math.round(t.chatFontSize.meta * t.lineHeightRatio);
  const contentHeight = Math.max(
    captionLine,
    t.foundation.typography.meta.lineHeight + 2 * t.uiSpacing.xxs,
  );
  const overlap = Math.max(0, (t.hitTarget.min - contentHeight - 2 * t.spacing.xs) / 2);
  const captionText = {
    ...t.foundation.typography.meta,
    fontSize: t.chatFontSize.meta,
    lineHeight: captionLine,
  };

  return StyleSheet.create({
    row: {
      width: '100%',
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: getChatRowHorizontalInset(t, presentation, t.spacing.lg),
      minHeight: t.hitTarget.min,
      // 실제 터치 영역은 유지하고 이웃과 겹쳐 배치해 보이는 간격만 좁힌다.
      marginVertical: -overlap,
    },
    badge: { flexShrink: 0 },
    textGroup: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.spacing.xs,
      minWidth: 0,
    },
    number: { ...captionText, color: t.colors.textMuted, flexShrink: 0 },
    title: { ...captionText, color: t.colors.textPrimary, flexShrink: 1 },
    detail: { ...captionText, color: t.colors.textMuted, flexShrink: 100 },
    pressed: { opacity: 0.82 },
  });
}
