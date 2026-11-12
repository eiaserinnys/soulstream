import React, { useMemo, useRef, useState } from 'react';
import { TouchableWithoutFeedback, Text, View } from 'react-native';
import type { CardAttachment, CardComment, CardDetail, CardQuestion, CardReport } from '../../api/cardTypes';
import type { Session, SessionEvent } from '../../api/types';
import { cardItemTargetText, formatCardTime } from '../../lib/card-check-item-summary';
import { useSessionStore } from '../../store/sessionStore';
import { useTokens } from '../../theme';
import { UserMessage } from '../events/UserMessage';
import { AssistantMessage } from '../events/AssistantMessage';
import { CompactTouchTarget } from '../CompactTouchTarget';
import { AttachmentImage } from '../AttachmentImage';
import { CardRequestView } from './CardRequestView';
import { CardReportView } from './CardReportView';
import { cardDetailStyles } from './CardDetail.styles';
import { cardImageSource } from '../../lib/card-image-source';
import { segmentCardReportImages } from '../../lib/card-report-images';
import { useAuthStore } from '../../store/authStore';
import { useSettingsStore } from '../../store/settingsStore';
import { extractCardBodyLinks } from '../../lib/card-body-attachments';
import { parseExactAttachmentLink, scopedAttachmentUrl } from '../../lib/attachment-link-view';
import { useOpenContentLink } from '../../hooks/useOpenContentLink';
import { AttachmentReadContextProvider } from '../../navigation/ContentLinkProvider';
import { CardQuestionActions, CardQuestionBody } from './CardQuestionBlock';
import { cardQuestionViewFromDetail, type CardQuestionView } from './card-question-viewmodel';

type Entry = { id: string; kind: string; user: boolean; body: string; at: string; sessionId?: string | null;
  itemId?: number | null; spoken?: boolean; withdrawn?: boolean; report?: CardReport; question?: CardQuestion; attachments?: CardAttachment[] };

type RequestSource = { request: string; createdAt: string; attachments?: CardAttachment[] };
type Source = RequestSource | CardQuestion | CardReport | CardComment;
type EntryType = 'request' | 'question' | 'answer' | 'report' | 'comment';
type TimelineItem = { id: string; type: EntryType; source: Source; at: string; sessionId?: string | null; questionView?: CardQuestionView };

/** 카드 #1197: 새 질문 장. 열린 질문은 커멘트 탭 맨 아래, 입력창 바로 위에 선다. */
export type CardQuestionHandlers = { portraitUri: string | null; onChoose(questionId: string, label: string): void; onAskBack(questionId: string): void; onDone(questionId: string): void };
const PINNED_AT = '9999-12-31T00:00:00Z';

export const CardTimeline = React.memo(function CardTimeline({ detail, onChooseAnswer, commentsOnly = false, questionHandlers }: {
  commentsOnly?: boolean; detail: CardDetail; onChooseAnswer(answer: string): void; questionHandlers?: CardQuestionHandlers;
}) {
  const catalog = useSessionStore((state) => state.sessions);
  const t = useTokens();
  const styles = useMemo(() => cardDetailStyles(t), [t]);
  const assigned = catalog[detail.card.assigneeSessionId ?? ''] ?? detail.sessions.find((session) => session.agentSessionId === detail.card.assigneeSessionId);
  const request = useMemo(() => ({ request: detail.card.request, createdAt: detail.card.createdAt, attachments: detail.card.attachments }),
    [detail.card.request, detail.card.createdAt, detail.card.attachments]);
  // 상세 재조회가 같은 질문을 같은 모양으로 돌려주면 보기 모델도 같은 객체를 돌려줘야
  // 타임라인 행의 memo 경계가 유지된다.
  const viewCache = useRef(new Map<string, { question: CardQuestion; comments: readonly CardComment[]; view: CardQuestionView }>());
  const questionViewFor = (question: CardQuestion) => {
    const relevant = (detail.comments ?? []).filter(comment => comment.questionId === question.id);
    const cached = viewCache.current.get(question.id);
    if (cached && cached.question === question && cached.comments.length === relevant.length
      && cached.comments.every((comment, index) => comment === relevant[index])) return cached.view;
    const view = cardQuestionViewFromDetail(question, detail.comments ?? [], detail.card.title);
    viewCache.current.set(question.id, { question, comments: relevant, view });
    return view;
  };
  const items: TimelineItem[] = [
    { id: 'request', type: 'request' as const, source: request, at: request.createdAt },
    ...detail.questions.flatMap((question): TimelineItem[] => {
      const questionView = questionHandlers ? questionViewFor(question) : null;
      return [
        { id: `question-${question.id}`, type: 'question', source: question, at: questionView?.open ? PINNED_AT : question.askedAt, sessionId: question.sessionId, questionView: questionView ?? undefined },
        ...(question.answer === null ? [] : [{ id: `answer-${question.id}`, type: 'answer' as const, source: question, at: question.answeredAt ?? question.askedAt }]),
      ];
    }),
    ...detail.reports.map((report): TimelineItem => ({ id: `report-${report.id}`, type: 'report', source: report, at: report.createdAt, sessionId: report.sessionId })),
    ...(detail.comments ?? []).filter((comment) => comment.kind !== 'note' && !comment.questionId)
      .map((comment): TimelineItem => ({ id: `comment-${comment.id}`, type: 'comment', source: comment, at: comment.createdAt, sessionId: comment.sessionId })),
  ].sort((a, b) => a.at < b.at ? -1 : a.at > b.at ? 1 : 0);
  return <View testID="card-timeline" style={styles.timeline}>{items.filter(item => !commentsOnly || item.type === 'comment').map((item) => {
    const author = catalog[item.sessionId ?? ''] ?? detail.sessions.find((session) => session.agentSessionId === item.sessionId) ?? assigned;
    return <TimelineMessage key={item.id} id={item.id} type={item.type} source={item.source} author={author}
      cardId={detail.card.id} agentId={detail.card.assigneeAgentId} nodeId={detail.card.nodeId} target={item.type === 'comment' && (item.source as CardComment).itemId != null ? cardItemTargetText((item.source as CardComment).itemId!, detail.card.items?.find(row => row.id === (item.source as CardComment).itemId)?.title) : undefined} onChooseAnswer={onChooseAnswer} questionView={item.questionView} questionHandlers={questionHandlers} />;
  })}</View>;
});

function makeEntry(id: string, type: EntryType, source: Source): Entry {
  switch (type) {
    case 'request': {
      const request = source as RequestSource;
      return { id, kind: '지시', user: true, body: request.request, at: request.createdAt, attachments: request.attachments };
    }
    case 'question': {
      const question = source as CardQuestion;
      return { id, kind: '질문', user: false, body: question.text, at: question.askedAt, sessionId: question.sessionId, withdrawn: !!question.withdrawnAt, question };
    }
    case 'answer': {
      const question = source as CardQuestion;
      return { id, kind: '답', user: true, body: question.answer!, at: question.answeredAt ?? question.askedAt };
    }
    case 'report': {
      const report = source as CardReport;
      return { id, kind: '보고', user: false, body: report.body, at: report.createdAt, sessionId: report.sessionId, report };
    }
    case 'comment': {
      const comment = source as CardComment;
      return { id, kind: '커멘트', user: comment.authorKind === 'user', body: comment.body, at: comment.createdAt, sessionId: comment.sessionId, itemId: comment.itemId, spoken: comment.kind === 'spoken' };
    }
  }
}

const TimelineMessage = React.memo(function TimelineMessage({ id, type, source, author, cardId, agentId: fallbackAgentId, nodeId: fallbackNodeId, target, onChooseAnswer, questionView, questionHandlers }: {
  id: string; type: EntryType; source: Source; author?: Session; cardId: string; agentId: string | null; nodeId: string | null; target?: string;
  onChooseAnswer(answer: string): void; questionView?: CardQuestionView; questionHandlers?: CardQuestionHandlers;
}) {
  const t = useTokens();
  const styles = useMemo(() => cardDetailStyles(t), [t]);
  const entry = makeEntry(id, type, source);
  const agentId = author?.agentId ?? fallbackAgentId;
  const nodeId = author?.nodeId ?? fallbackNodeId;
  const session: Session = { ...author, agentSessionId: author?.agentSessionId ?? entry.sessionId ?? cardId, displayName: author?.displayName ?? null, status: author?.status ?? 'idle', createdAt: author?.createdAt ?? entry.at, updatedAt: author?.updatedAt ?? entry.at, agentId, agentName: author?.agentName ?? agentId, agentPortraitUrl: author?.agentPortraitUrl ?? (agentId && nodeId ? `/api/nodes/${nodeId}/agents/${agentId}/portrait` : null) };
  const event: SessionEvent = { id: entry.id, type: entry.user ? 'user_message' : 'assistant_message', data: { text: entry.body } };
  const newQuestion = questionHandlers && questionView ? questionView : null;
  const kindLabel = newQuestion?.kind === 'request' ? '부탁' : entry.kind;
  const kind = <View style={styles.kindRow}><Text style={[styles.kind, { color: entry.kind === '질문' ? t.colors.warning : entry.user ? t.colors.accent : t.colors.success }]}>{kindLabel}</Text>
    {entry.spoken ? <Text style={styles.meta}>대화에서</Text> : null}{entry.withdrawn ? <Text style={styles.meta}>철회됨</Text> : null}
    {newQuestion?.revisedAt ? <Text style={styles.meta}>{`고침 ${formatCardTime(newQuestion.revisedAt)}`}</Text> : <Text style={styles.meta}>{formatCardTime(entry.at)}</Text>}</View>;
  const [expanded, setExpanded] = useState(false);
  const fold = !!entry.report || entry.kind === '지시';
  const label = expanded ? '접기' : entry.report ? '자세히' : '더 보기';
  const body = newQuestion && questionHandlers ? <View style={{ gap: t.uiSpacing.md }}>
    {newQuestion.title ? <Text style={{ ...t.foundation.typography.cardTitle, color: t.colors.textPrimary }}>{newQuestion.title}</Text> : null}
    <CardQuestionBody view={newQuestion} cardId={cardId} portraitUri={questionHandlers.portraitUri}
      onChoose={label => questionHandlers.onChoose(newQuestion.id, label)} />
    {entry.question?.withdrawnAt && entry.question.withdrawalReason
      ? <Text testID={`card-question-withdrawal-${entry.id}`} style={styles.withdrawalReason}>{entry.question.withdrawalReason}</Text> : null}
    <CardQuestionActions view={newQuestion} composerVisible onAnswerFreely={() => {}} onAskBack={() => questionHandlers.onAskBack(newQuestion.id)} onDone={() => questionHandlers.onDone(newQuestion.id)} />
  </View> : <TimelineBody cardId={cardId} target={target} entry={entry} expanded={expanded} onChooseAnswer={onChooseAnswer} />;
  const message = entry.user ? <UserMessage event={event} session={session} messageKind={kind}>{body}</UserMessage>
    : <AssistantMessage rowInset="none" event={event} session={session} messageKind={kind} bubbleWidth={entry.report || newQuestion ? 'fill' : 'content'}>{body}</AssistantMessage>;
  return fold ? <TouchableWithoutFeedback testID={`card-fold-${entry.id}`} accessibilityRole="button" accessibilityLabel={`${entry.id} ${label}`}
    onPress={() => setExpanded((old) => !old)}><View>{message}</View></TouchableWithoutFeedback> : message;
});

function TimelineBody({ cardId, entry, target, expanded, onChooseAnswer }: { cardId: string; entry: Entry; target?: string; expanded: boolean; onChooseAnswer(answer: string): void }) {
  const t = useTokens();
  const styles = useMemo(() => cardDetailStyles(t), [t]);
  const report = entry.report;
  const jwt = useAuthStore((state) => state.jwt);
  const serverUrl = useSettingsStore((state) => state.serverUrl);
  const preview = report ? reportSummary(report) : entry.body;
  const fold = report || entry.kind === '지시';
  const links = report ? extractCardBodyLinks(report.body) : [];
  const openContentLink = useOpenContentLink({ type: 'card', id: cardId }, links);
  const imageUrls = report ? reportImages(report) : [];
  const gallery = imageUrls.map(uri => cardImageSource(scopedAttachmentUrl(uri, serverUrl, { type: 'card', id: cardId }), serverUrl, jwt));
  const images = gallery.slice(0, 2);
  const expandedMarkdown = expanded && report?.format === 'markdown';
  return <AttachmentReadContextProvider context={{ type: 'card', id: cardId }}><View style={styles.bodyStack}>
    {target ? <Text testID={`card-comment-item-target-${entry.id}`} numberOfLines={1} style={styles.commentTarget}>{target}</Text> : null}
    {!fold || (expanded && entry.kind === '지시') ? <CardRequestView request={entry.body} attachments={entry.attachments} /> : !expandedMarkdown ? <Text style={styles.body} numberOfLines={fold && !expanded ? 3 : undefined}>{preview}</Text> : null}
    {entry.question?.withdrawnAt && entry.question.withdrawalReason ? <Text testID={`card-question-withdrawal-${entry.id}`} style={styles.withdrawalReason}>{entry.question.withdrawalReason}</Text> : null}
    {images.length && !expandedMarkdown ? <View style={styles.thumbnails}>{images.map((source, index) => <AttachmentImage key={source.uri}
      testID={`card-report-thumbnail-${report!.id}-${index}`} onOpen={parseExactAttachmentLink(imageUrls[index], serverUrl) ? restoreFocus => { void openContentLink(imageUrls[index], undefined, restoreFocus); } : undefined} source={source} sources={gallery} index={index} accessibilityLabel={`보고 캡처 ${index + 1}`} />)}</View> : null}
    {fold ? <Text style={styles.meta}>{expanded ? '접기' : report ? '자세히' : '더 보기'}</Text> : null}
    {expanded && report ? <CardReportView report={report} /> : null}
    {entry.question?.answer === null && !entry.withdrawn ? entry.question.options?.map((option) => <CompactTouchTarget key={option}
      accessibilityRole="button" accessibilityLabel={option} surfaceStyle={styles.option} onPress={() => onChooseAnswer(option)}><Text style={styles.link}>{option}</Text></CompactTouchTarget>) : null}
  </View></AttachmentReadContextProvider>;
}

export function reportImages(report: CardReport): string[] {
  return report.format === 'html'
    ? [...report.body.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["']/gi)].map((match) => match[1])
    : segmentCardReportImages(report.body).flatMap((part) => part.kind === 'image' ? [part.url] : []);
}
export function reportSummary(report: CardReport): string {
  const text = report.format === 'html'
    ? report.body.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<\/(p|div|h[1-6])>/gi, '\n\n').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    : segmentCardReportImages(report.body).flatMap((part) => part.kind === 'markdown' ? [part.markdown] : []).join('\n');
  return text.trim().replace(/!\[[^\]]*\]\([^)]*\)/g, '').trim();
}
