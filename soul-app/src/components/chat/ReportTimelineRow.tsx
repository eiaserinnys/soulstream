import { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { CardDto } from '../../api/cardTypes';
import { useOpenContentLink } from '../../hooks/useOpenContentLink';
import { REPORT_TIMELINE_STATUS_LABEL, type ReportTimelineRowLine } from '../../../../packages/wire-schema/src/persistent_report';
import { useCardStore } from '../../store/cardStore';
import { useTokens, type DesignTokens } from '../../theme';
import { CardStatusChip } from '../planner/CardRow';
import { getChatRowHorizontalInset } from './ChatBody.styles';

interface Props {
  line: ReportTimelineRowLine;
  presentation?: 'default' | 'manuscript';
  onOpenCard?: (cardId: string) => void;
}

function isQuestionRow(line: ReportTimelineRowLine): boolean {
  return line.question_id !== undefined || line.status === 'question'
    || line.status === 'answered' || line.status === 'withdrawn';
}

/** 카드 하나의 실제 상태를 그리는 일반 현황 줄인가. */
function isCardStatusRow(line: ReportTimelineRowLine): boolean {
  return line.card_id !== null && line.status !== 'report' && !isQuestionRow(line);
}

/** 기록된 줄 대신 지금 카드 행의 상태·제목·상황을 보여 준다. */
function liveRow(line: ReportTimelineRowLine, card: CardDto): ReportTimelineRowLine {
  const status = card.status === 'blocked' && card.blockedKind === 'question' ? 'question' : card.status;
  const detail = card.status === 'done' || card.status === 'cancelled' || card.status === 'on_hold'
    ? ''
    : ((card.now?.turn === 'user' && card.now.ask ? card.now.ask : card.now?.text) || card.blockedDetail || line.detail);
  return { ...line, status, title: card.title || line.title, detail };
}

function statusCard(line: ReportTimelineRowLine): CardDto {
  const status = line.status === 'question' ? 'blocked'
    : line.status === 'on_hold' || line.status === 'report' || line.status === 'answered' || line.status === 'withdrawn' ? 'todo'
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
  const liveCard = useCardStore((state) => (line.card_id ? state.rows[line.card_id] : undefined));
  const shown = liveCard !== undefined && isCardStatusRow(line) ? liveRow(line, liveCard) : line;
  const card = statusCard(shown);
  const content = <>
    <View style={styles.badge}>
      <CardStatusChip card={card} detail label={REPORT_TIMELINE_STATUS_LABEL[shown.status]} />
    </View>
    <View style={styles.textGroup}>
      {shown.card_number !== null ? <Text style={styles.number} numberOfLines={1}>#{shown.card_number}</Text> : null}
      <Text style={styles.title} numberOfLines={1}>{shown.title}</Text>
      {shown.detail ? <Text style={styles.detail} numberOfLines={1}>{shown.detail}</Text> : null}
    </View>
  </>;

  if (!line.card_id) return <View style={styles.row}>{content}</View>;
  return <Pressable
    accessibilityRole="link"
    accessibilityLabel={`#${line.card_number ?? ''} ${shown.title}`.trim()}
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
    // 제목이 제 폭을 먼저 쓰고 상황판은 남는 폭만 쓴다.
    detail: { ...captionText, color: t.colors.textMuted, flex: 1, minWidth: 0 },
    pressed: { opacity: 0.82 },
  });
}
