import React, { useMemo, useState } from 'react';
import { TouchableWithoutFeedback, Text, View } from 'react-native';
import type { CardAttachment, CardComment, CardDetail, CardQuestion, CardReport } from '../../api/cardTypes';
import type { Session, SessionEvent } from '../../api/types';
import { formatRelativeTime } from '../../lib/relative-time';
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

type Entry = { id: string; kind: string; user: boolean; body: string; at: string; sessionId?: string | null;
  spoken?: boolean; report?: CardReport; question?: CardQuestion; attachments?: CardAttachment[] };

type RequestSource = { request: string; createdAt: string; attachments?: CardAttachment[] };
type Source = RequestSource | CardQuestion | CardReport | CardComment;
type EntryType = 'request' | 'question' | 'answer' | 'report' | 'comment';
type TimelineItem = { id: string; type: EntryType; source: Source; at: string; sessionId?: string | null };

export const CardTimeline = React.memo(function CardTimeline({ detail, onChooseAnswer }: { detail: CardDetail; onChooseAnswer(answer: string): void }) {
  const catalog = useSessionStore((state) => state.sessions);
  const t = useTokens();
  const styles = useMemo(() => cardDetailStyles(t), [t]);
  const assigned = catalog[detail.card.assigneeSessionId ?? ''] ?? detail.sessions.find((session) => session.agentSessionId === detail.card.assigneeSessionId);
  const request = useMemo(() => ({ request: detail.card.request, createdAt: detail.card.createdAt, attachments: detail.card.attachments }),
    [detail.card.request, detail.card.createdAt, detail.card.attachments]);
  const items: TimelineItem[] = [
    { id: 'request', type: 'request' as const, source: request, at: request.createdAt },
    ...detail.questions.flatMap((question): TimelineItem[] => [
      { id: `question-${question.id}`, type: 'question', source: question, at: question.askedAt, sessionId: question.sessionId },
      ...(question.answer === null ? [] : [{ id: `answer-${question.id}`, type: 'answer' as const, source: question, at: question.answeredAt ?? question.askedAt }]),
    ]),
    ...detail.reports.map((report): TimelineItem => ({ id: `report-${report.id}`, type: 'report', source: report, at: report.createdAt, sessionId: report.sessionId })),
    ...(detail.comments ?? []).filter((comment) => comment.kind !== 'note')
      .map((comment): TimelineItem => ({ id: `comment-${comment.id}`, type: 'comment', source: comment, at: comment.createdAt, sessionId: comment.sessionId })),
  ].sort((a, b) => a.at < b.at ? -1 : a.at > b.at ? 1 : 0);
  return <View testID="card-timeline" style={styles.timeline}>{items.map((item) => {
    const author = catalog[item.sessionId ?? ''] ?? detail.sessions.find((session) => session.agentSessionId === item.sessionId) ?? assigned;
    return <TimelineMessage key={item.id} id={item.id} type={item.type} source={item.source} author={author}
      cardId={detail.card.id} agentId={detail.card.assigneeAgentId} nodeId={detail.card.nodeId} onChooseAnswer={onChooseAnswer} />;
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
      return { id, kind: '질문', user: false, body: question.text, at: question.askedAt, sessionId: question.sessionId, question };
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
      return { id, kind: '커멘트', user: comment.authorKind === 'user', body: comment.body, at: comment.createdAt, sessionId: comment.sessionId, spoken: comment.kind === 'spoken' };
    }
  }
}

const TimelineMessage = React.memo(function TimelineMessage({ id, type, source, author, cardId, agentId: fallbackAgentId, nodeId: fallbackNodeId, onChooseAnswer }: {
  id: string; type: EntryType; source: Source; author?: Session; cardId: string; agentId: string | null; nodeId: string | null; onChooseAnswer(answer: string): void;
}) {
  const t = useTokens();
  const styles = useMemo(() => cardDetailStyles(t), [t]);
  const entry = makeEntry(id, type, source);
  const agentId = author?.agentId ?? fallbackAgentId;
  const nodeId = author?.nodeId ?? fallbackNodeId;
  const session: Session = { ...author, agentSessionId: author?.agentSessionId ?? entry.sessionId ?? cardId, displayName: author?.displayName ?? null, status: author?.status ?? 'idle', createdAt: author?.createdAt ?? entry.at, updatedAt: author?.updatedAt ?? entry.at, agentId, agentName: author?.agentName ?? agentId, agentPortraitUrl: author?.agentPortraitUrl ?? (agentId && nodeId ? `/api/nodes/${nodeId}/agents/${agentId}/portrait` : null) };
  const event: SessionEvent = { id: entry.id, type: entry.user ? 'user_message' : 'assistant_message', data: { text: entry.body } };
  const kind = <View style={styles.kindRow}><Text style={[styles.kind, { color: entry.kind === '질문' ? t.colors.warning : entry.user ? t.colors.accent : t.colors.success }]}>{entry.kind}</Text>
    {entry.spoken ? <Text style={styles.meta}>대화에서</Text> : null}<Text style={styles.meta}>{formatRelativeTime(entry.at)}</Text></View>;
  const [expanded, setExpanded] = useState(false);
  const fold = !!entry.report || entry.kind === '지시';
  const label = expanded ? '접기' : entry.report ? '자세히' : '더 보기';
  const body = <TimelineBody entry={entry} expanded={expanded} onChooseAnswer={onChooseAnswer} />;
  const message = entry.user ? <UserMessage event={event} session={session} messageKind={kind}>{body}</UserMessage>
    : <AssistantMessage event={event} session={session} messageKind={kind} bubbleWidth={entry.report ? 'fill' : 'content'}>{body}</AssistantMessage>;
  return fold ? <TouchableWithoutFeedback testID={`card-fold-${entry.id}`} accessibilityRole="button" accessibilityLabel={`${entry.id} ${label}`}
    onPress={() => setExpanded((old) => !old)}><View>{message}</View></TouchableWithoutFeedback> : message;
});

function TimelineBody({ entry, expanded, onChooseAnswer }: { entry: Entry; expanded: boolean; onChooseAnswer(answer: string): void }) {
  const t = useTokens();
  const styles = useMemo(() => cardDetailStyles(t), [t]);
  const report = entry.report;
  const jwt = useAuthStore((state) => state.jwt);
  const serverUrl = useSettingsStore((state) => state.serverUrl);
  const preview = report ? reportSummary(report) : entry.body;
  const fold = report || entry.kind === '지시';
  const gallery = report ? reportImages(report).map((uri) => cardImageSource(uri, serverUrl, jwt)) : [];
  const images = gallery.slice(0, 2);
  const expandedMarkdown = expanded && report?.format === 'markdown';
  return <View style={styles.bodyStack}>
    {!fold || (expanded && entry.kind === '지시') ? <CardRequestView request={entry.body} attachments={entry.attachments} /> : !expandedMarkdown ? <Text style={styles.body} numberOfLines={fold && !expanded ? 3 : undefined}>{preview}</Text> : null}
    {images.length && !expandedMarkdown ? <View style={styles.thumbnails}>{images.map((source, index) => <AttachmentImage key={source.uri}
      testID={`card-report-thumbnail-${report!.id}-${index}`} source={source} sources={gallery} index={index} accessibilityLabel={`보고 캡처 ${index + 1}`} />)}</View> : null}
    {fold ? <Text style={styles.meta}>{expanded ? '접기' : report ? '자세히' : '더 보기'}</Text> : null}
    {expanded && report ? <CardReportView report={report} /> : null}
    {entry.question?.answer === null ? entry.question.options?.map((option) => <CompactTouchTarget key={option}
      accessibilityRole="button" accessibilityLabel={option} surfaceStyle={styles.option} onPress={() => onChooseAnswer(option)}><Text style={styles.link}>{option}</Text></CompactTouchTarget>) : null}
  </View>;
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
