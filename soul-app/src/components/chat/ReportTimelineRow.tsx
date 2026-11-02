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
    {line.card_number !== null ? <Text style={styles.number} numberOfLines={1}>#{line.card_number}</Text> : null}
    <Text style={styles.title} numberOfLines={1}>{line.title}</Text>
    {line.detail ? <Text style={styles.detail} numberOfLines={1}>{line.detail}</Text> : null}
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
  return StyleSheet.create({
    row: {
      width: '100%',
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.spacing.xs,
      paddingHorizontal: getChatRowHorizontalInset(t, presentation, t.spacing.lg),
      paddingVertical: t.spacing.xs,
    },
    badge: { flexShrink: 0 },
    number: { ...t.foundation.typography.meta, color: t.colors.text, flexShrink: 0 },
    title: { ...t.foundation.typography.meta, color: t.colors.text, flexShrink: 1 },
    detail: { ...t.foundation.typography.meta, color: t.colors.textMuted, flexShrink: 1 },
    pressed: { opacity: 0.82 },
  });
}
