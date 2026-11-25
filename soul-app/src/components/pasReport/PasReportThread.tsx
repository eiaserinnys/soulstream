// 카드 #1871: 보고 창의 시간순 사건 스레드. 원 요청, 한 줄 이정표, 커멘트, 질문, 접은 기술 기록을 한 줄기로 보이고
// 맨 아래에 확인 항목을 둔다. 맨 아래에서 시작하고, 위로 올리면 「최신 경과로 ↓」 알약이 겹쳐 뜬다.
import React, { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { CardComment, CardDetail, CardQuestion } from '../../api/cardTypes';
import { cardItemTargetText, formatCardTime } from '../../lib/card-check-item-summary';
import type { ThreadItem } from '../../../../packages/soul-ui/src/lib/pas-report-thread-core';
import { buildThread, summarizeTechnicalNotes } from '../../lib/pas-report-thread-model';
import { useAgentPortraitResolver } from '../../store/agentPortraitStore';
import { withAlpha } from '../../theme/surfaceRoles';
import { useTokens, type DesignTokens } from '../../theme';
import { CompactTouchTarget } from '../CompactTouchTarget';
import { DisclosureIcon } from '../DisclosureIcon';
import { FrameLoading } from '../FrameLoading';
import { GlassButton } from '../GlassSurface';
import { LiquidGlassButton } from '../LiquidGlassButton';
import { CardCheckItems } from '../planner/CardCheckItems';
import { CardQuestionBody } from '../planner/CardQuestionBlock';
import { CardRequestView } from '../planner/CardRequestView';
import { cardQuestionViewFromDetail, type CardQuestionView } from '../planner/card-question-viewmodel';
import type { useScrollFollow } from './useScrollFollow';
import type { PasReportWindowController } from './usePasReportWindow';

type Follow = ReturnType<typeof useScrollFollow>;

export function PasReportThread({ controller, follow, paneWidth }: { controller: PasReportWindowController; follow: Follow; paneWidth: number }) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);
  const { detail, loadState, active } = controller;
  if (!active) return <View style={styles.state} testID="pas-report-thread-empty"><Text style={styles.stateText}>결재할 안건이 없어.</Text></View>;
  if (!detail) {
    return loadState === 'error'
      ? <View style={styles.state} testID="pas-report-thread-error" accessibilityRole="alert">
        <Text style={styles.stateText}>카드를 불러오지 못했어.</Text>
        <GlassButton size="compact" variant="paper" accessibilityLabel="카드 다시 시도" onPress={controller.retry}>
          <Text style={styles.stateAction}>다시 시도</Text>
        </GlassButton>
      </View>
      : <View style={styles.state} testID="pas-report-thread-loading"><FrameLoading text="불러오는 중" /></View>;
  }
  // 카드마다 새로 선다. 원 요청 펼침 같은 지역 상태가 카드를 오가며 따라가지 않게 한다.
  return <ThreadBody key={detail.card.id} controller={controller} follow={follow} paneWidth={paneWidth} detail={detail} />;
}

function ThreadBody({ controller, follow, paneWidth, detail }: {
  controller: PasReportWindowController; follow: Follow; paneWidth: number; detail: CardDetail;
}) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);
  const portraits = useAgentPortraitResolver();
  const thread = useMemo(() => buildThread(detail), [detail]);
  const portraitUri = portraits.forSession(null, detail.card.assigneeAgentId) || null;
  const items = controller.itemActions.items;
  const [visit, setVisit] = useState<{ cardId: string; initial: number[]; newly: number[] } | null>(null);
  if (visit?.cardId !== detail.card.id) {
    setVisit({ cardId: detail.card.id, initial: items.filter(item => item.display === 'confirmed').map(item => item.id), newly: [] });
  }
  const current = visit?.cardId === detail.card.id ? visit : { cardId: detail.card.id, initial: [], newly: [] };
  const setRecent = (itemId: number, confirmed: boolean) => setVisit(saved => saved && ({
    ...saved, newly: confirmed ? [...saved.newly.filter(id => id !== itemId), itemId] : saved.newly.filter(id => id !== itemId),
  }));
  return <View style={styles.threadFrame}>
    <ScrollView testID="pas-report-thread-scroll" ref={follow.scrollRef} {...follow.scrollProps} style={styles.scroll}
      contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
      <View testID="pas-report-timeline" style={styles.timeline}>
        {thread.map(item => <ThreadRow key={item.id} item={item} detail={detail} portraitUri={portraitUri} styles={styles} />)}
      </View>
      {items.length ? <View testID="pas-report-items" style={styles.items}>
        <CardCheckItems key={detail.card.id} cardId={detail.card.id} items={items} pendingConfirmations={controller.itemActions.pendingConfirmations}
          initiallyConfirmedIds={current.initial} newlyConfirmedIds={current.newly} onConfirm={controller.itemActions.confirm}
          onSetTarget={(item, trigger) => controller.setTargetItem(item.id, trigger)} onRecentConfirmation={setRecent} paneWidth={paneWidth} />
      </View> : null}
    </ScrollView>
    {follow.following ? null : <View pointerEvents="box-none" style={styles.pillSeat}>
      <LiquidGlassButton testID="pas-report-latest-pill" borderRadius={t.foundation.radius.capsule} size="compact" variant="paper"
        accessibilityLabel="최신 경과로 ↓" onPress={follow.jumpToLatest}>
        <Text style={styles.pillText}>최신 경과로 ↓</Text>
      </LiquidGlassButton>
    </View>}
  </View>;
}

type Styles = ReturnType<typeof makeStyles>;

const ThreadRow = React.memo(function ThreadRow({ item, detail, portraitUri, styles }: {
  item: ThreadItem<CardComment, CardQuestion>; detail: CardDetail; portraitUri: string | null; styles: Styles;
}) {
  switch (item.kind) {
    case 'request': return <RequestRow detail={detail} styles={styles} />;
    case 'milestone': return <MilestoneRow item={item} styles={styles} />;
    case 'comments': return <View style={styles.comments}>{item.comments.map(comment =>
      <CommentRow key={comment.id} comment={comment} detail={detail} styles={styles} />)}</View>;
    case 'question': return <QuestionRow question={item.question} detail={detail} portraitUri={portraitUri} styles={styles} />;
    case 'notes': return <NotesRow notes={item.notes} styles={styles} />;
  }
});

function RequestRow({ detail, styles }: { detail: CardDetail; styles: Styles }) {
  const [expanded, setExpanded] = useState(false);
  const card = detail.card;
  const long = card.request.split('\n').length > 6 || card.request.length > 280;
  return <View testID="pas-report-request" style={styles.bubble}>
    <View style={styles.labelRow}><Text style={styles.label}>원 요청</Text><Text style={styles.time}>{formatCardTime(card.createdAt)}</Text></View>
    <CardRequestView request={card.request} attachments={card.attachments} numberOfLines={long && !expanded ? 6 : undefined} />
    {long ? <CompactTouchTarget accessibilityRole="button" accessibilityLabel={expanded ? '원 요청 접기' : '원 요청 더 보기'}
      frameStyle={styles.foldFrame} onPress={() => setExpanded(value => !value)}>
      <Text style={styles.link}>{expanded ? '접기' : '더 보기'}</Text>
    </CompactTouchTarget> : null}
  </View>;
}

function MilestoneRow({ item, styles }: { item: Extract<ThreadItem<CardComment, CardQuestion>, { kind: 'milestone' }>; styles: Styles }) {
  const time = formatCardTime(new Date(item.at).toISOString());
  return <View testID={`pas-report-milestone-${item.tone}`} style={styles.milestone}>
    <View style={[styles.dot, item.tone === 'delegate' && styles.dotDelegate]} />
    <Text selectable style={styles.milestoneText}>{time ? <Text style={styles.time}>{time}  </Text> : null}{item.text}</Text>
  </View>;
}

function CommentRow({ comment, detail, styles }: { comment: CardComment; detail: CardDetail; styles: Styles }) {
  const target = comment.itemId != null ? cardItemTargetText(comment.itemId, detail.card.items?.find(row => row.id === comment.itemId)?.title) : null;
  const label = comment.kind === 'spoken' ? '발언 기록' : comment.authorKind === 'user' ? '사용자' : '담당';
  return <View testID="pas-report-comment" style={[styles.bubble, comment.authorKind === 'user' && styles.bubbleUser]}>
    <View style={styles.labelRow}><Text style={styles.label}>{label}</Text><Text style={styles.time}>{formatCardTime(comment.createdAt)}</Text></View>
    {target ? <Text numberOfLines={1} style={styles.time}>{target}</Text> : null}
    <CardRequestView request={comment.body} />
  </View>;
}

function QuestionRow({ question, detail, portraitUri, styles }: {
  question: CardQuestion; detail: CardDetail; portraitUri: string | null; styles: Styles;
}) {
  const t = useTokens();
  const view = useMemo(() => cardQuestionViewFromDetail(question, detail.comments ?? [], detail.card.title), [question, detail.comments, detail.card.title]);
  const closed = !view.open;
  // 열린 질문의 선택지는 결재 상자 한 곳에서만 고른다. 여기서는 제목, 배경, 되묻기 글타래와 선택지 설명을 읽기만 한다.
  const body: CardQuestionView = closed ? view : { ...view, options: [] };
  return <View testID={`pas-report-question-${question.id}`} style={styles.bubble}>
    <View style={styles.labelRow}>
      <Text style={styles.label}>{view.kind === 'request' ? '부탁' : '질문'}</Text>
      {question.withdrawnAt ? <Text style={styles.time}>철회됨</Text> : null}
      <Text style={styles.time}>{formatCardTime(question.askedAt)}</Text>
    </View>
    {view.title ? <Text selectable style={{ ...t.foundation.typography.cardTitle, color: t.colors.textPrimary }}>{view.title}</Text> : null}
    <CardQuestionBody view={body} cardId={detail.card.id} portraitUri={portraitUri} onChoose={() => {}} busy />
    {!closed && view.kind === 'choice' && view.options.length ? <View testID={`pas-report-question-options-${question.id}`} style={styles.optionNotes}>
      {view.options.map(option => <View key={option.label} style={styles.optionNote}>
        <Text selectable style={styles.optionLabel}>{option.label}{option.recommended ? <Text style={styles.recommended}>{'  권함'}</Text> : null}</Text>
        {option.description ? <Text selectable style={styles.optionDescription}>{option.description}</Text> : null}
      </View>)}
    </View> : null}
    {closed && view.answer ? <Text selectable style={styles.answer}><Text style={styles.time}>받은 답  </Text>{view.answer}</Text> : null}
    {question.withdrawnAt && question.withdrawalReason ? <Text selectable style={styles.time}>{question.withdrawalReason}</Text> : null}
  </View>;
}

function NotesRow({ notes, styles }: { notes: CardComment[]; styles: Styles }) {
  const t = useTokens();
  const [open, setOpen] = useState(false);
  return <View testID="pas-report-notes" style={styles.notes}>
    <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} accessibilityLabel={summarizeTechnicalNotes(notes.length)}
      onPress={() => setOpen(value => !value)} style={styles.notesToggle}>
      <DisclosureIcon expanded={open} size={t.foundation.typography.meta.fontSize} color={t.colors.textSecondary} />
      <Text style={styles.notesLabel}>{summarizeTechnicalNotes(notes.length)}</Text>
    </Pressable>
    {open ? <View style={styles.notesList}>{notes.map(note => <Text key={note.id} selectable style={styles.noteLine}>
      <Text style={styles.time}>{formatCardTime(note.createdAt)}  </Text>{note.body}</Text>)}</View> : null}
  </View>;
}

function makeStyles(t: DesignTokens) {
  const type = t.foundation.typography;
  const dot = t.uiSpacing.sm;
  // 점, 접기 화살표, 이정표 글이 한 시작선에서 시작하게 점 자리를 하나로 둔다.
  const slot = t.uiSpacing.lg;
  return StyleSheet.create({
    state: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: t.uiSpacing.md, padding: t.uiSpacing.xl },
    stateText: { ...type.body, color: t.colors.textSecondary, textAlign: 'center' },
    stateAction: { ...type.body, color: t.colors.textPrimary },
    threadFrame: { flex: 1, minHeight: 0 },
    scroll: { flex: 1, minHeight: 0 },
    content: { paddingHorizontal: t.uiSpacing.lg, paddingTop: t.uiSpacing.lg, paddingBottom: t.uiSpacing.md, gap: t.uiSpacing.lg },
    timeline: { gap: t.uiSpacing.lg },
    items: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.colors.textMuted, paddingTop: t.uiSpacing.md },
    bubble: { gap: t.uiSpacing.sm, borderRadius: t.radius.floor, borderWidth: StyleSheet.hairlineWidth, borderColor: t.persistentSession.line,
      backgroundColor: t.persistentSession.panel, padding: t.uiSpacing.md },
    bubbleUser: { borderColor: t.colors.accent },
    comments: { gap: t.uiSpacing.sm },
    labelRow: { flexDirection: 'row', alignItems: 'center', columnGap: t.uiSpacing.sm },
    label: { ...type.meta, color: t.colors.textPrimary, fontWeight: '700' },
    time: { ...type.meta, color: t.colors.textSecondary, fontVariant: ['tabular-nums'] },
    link: { ...type.meta, color: t.colors.link },
    foldFrame: { alignSelf: 'flex-start', marginVertical: -t.uiSpacing.sm },
    milestone: { flexDirection: 'row', alignItems: 'flex-start', gap: slot - dot },
    // 점은 글의 첫 줄 가운데에 선다. 여러 줄로 감겨도 첫 줄에 맞는다.
    dot: { width: dot, height: dot, borderRadius: dot / 2, marginTop: (type.meta.lineHeight - dot) / 2, backgroundColor: t.colors.textMuted },
    dotDelegate: { backgroundColor: t.colors.link },
    milestoneText: { ...type.meta, flex: 1, minWidth: 0, color: t.colors.textSecondary },
    optionNotes: { gap: t.uiSpacing.sm },
    optionNote: { gap: t.uiSpacing.xxs, borderLeftWidth: t.uiSpacing.xs, borderLeftColor: withAlpha(t.colors.textSecondary, 0.55), paddingLeft: t.uiSpacing.md },
    recommended: { ...type.label, color: t.colors.accent },
    optionLabel: { ...type.body, fontWeight: '600', color: t.colors.textPrimary },
    optionDescription: { ...type.body, color: t.colors.textSecondary },
    answer: { ...type.body, color: t.colors.textPrimary },
    notes: { gap: t.uiSpacing.sm },
    notesToggle: { flexDirection: 'row', alignItems: 'center', gap: slot - type.meta.fontSize, minHeight: t.hitTarget.min, alignSelf: 'flex-start' },
    notesLabel: { ...type.meta, color: t.colors.textSecondary },
    notesList: { gap: t.uiSpacing.sm, paddingLeft: slot },
    noteLine: { ...type.meta, color: t.colors.textSecondary },
    pillSeat: { position: 'absolute', right: t.uiSpacing.lg, bottom: t.uiSpacing.md },
    pillText: { ...type.body, color: t.colors.textPrimary },
  });
}
