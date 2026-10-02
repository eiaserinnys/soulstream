import React, { useMemo, useState } from 'react';
import { TouchableWithoutFeedback, Text, View } from 'react-native';
import type { CardAttachment, CardDetail, CardQuestion, CardReport } from '../../api/cardTypes';
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

type Entry = { id: string; kind: string; user: boolean; body: string; at: string; sessionId?: string | null;
  spoken?: boolean; report?: CardReport; question?: CardQuestion; attachments?: CardAttachment[] };

export function CardTimeline({ detail, onChooseAnswer }: { detail: CardDetail; onChooseAnswer(answer: string): void }) {
  const catalog = useSessionStore((state) => state.sessions);
  const t = useTokens();
  const styles = useMemo(() => cardDetailStyles(t), [t]);
  const assigned = catalog[detail.card.assigneeSessionId ?? ''] ?? detail.sessions.find((session) => session.agentSessionId === detail.card.assigneeSessionId);
  const entries: Entry[] = [
    { id: 'request', kind: '지시', user: true, body: detail.card.request, at: detail.card.createdAt, attachments: detail.card.attachments },
    ...detail.questions.flatMap((question): Entry[] => [
      { id: `question-${question.id}`, kind: '질문', user: false, body: question.text, at: question.askedAt, sessionId: question.sessionId, question },
      ...(question.answer === null ? [] : [{ id: `answer-${question.id}`, kind: '답', user: true, body: question.answer, at: question.answeredAt ?? question.askedAt }]),
    ]),
    ...detail.reports.map((report): Entry => ({ id: `report-${report.id}`, kind: '보고', user: false, body: report.body, at: report.createdAt, sessionId: report.sessionId, report })),
    ...(detail.comments ?? []).map((comment): Entry => ({ id: `comment-${comment.id}`, kind: '커멘트', user: comment.authorKind === 'user', body: comment.body, at: comment.createdAt, sessionId: comment.sessionId, spoken: comment.kind === 'spoken' })),
  ].sort((a, b) => a.at < b.at ? -1 : a.at > b.at ? 1 : 0);
  return <View testID="card-timeline" style={styles.timeline}>{entries.map((entry) => {
    const author = catalog[entry.sessionId ?? ''] ?? detail.sessions.find((session) => session.agentSessionId === entry.sessionId) ?? assigned;
    const agentId = author?.agentId ?? detail.card.assigneeAgentId;
    const nodeId = author?.nodeId ?? detail.card.nodeId;
    const session: Session = { ...author, agentSessionId: author?.agentSessionId ?? entry.sessionId ?? detail.card.id, displayName: author?.displayName ?? null, status: author?.status ?? 'idle', createdAt: author?.createdAt ?? entry.at, updatedAt: author?.updatedAt ?? entry.at, agentId, agentName: author?.agentName ?? agentId, agentPortraitUrl: author?.agentPortraitUrl ?? (agentId && nodeId ? `/api/nodes/${nodeId}/agents/${agentId}/portrait` : null) };
    const event: SessionEvent = { id: entry.id, type: entry.user ? 'user_message' : 'assistant_message', data: { text: entry.body } };
    const kind = <View style={styles.kindRow}><Text style={[styles.kind, { color: entry.kind === '질문' ? t.colors.warning : entry.user ? t.colors.accent : t.colors.success }]}>{entry.kind}</Text>
      {entry.spoken ? <Text style={styles.meta}>대화에서</Text> : null}<Text style={styles.meta}>{formatRelativeTime(entry.at)}</Text></View>;
    return <TimelineMessage key={entry.id} entry={entry} event={event} session={session} kind={kind} onChooseAnswer={onChooseAnswer} />;
  })}</View>;
}

function TimelineMessage({ entry, event, session, kind, onChooseAnswer }: {
  entry: Entry; event: SessionEvent; session: Session; kind: React.ReactNode; onChooseAnswer(answer: string): void;
}) {
  const [expanded, setExpanded] = useState(false);
  const fold = !!entry.report || entry.kind === '지시';
  const label = expanded ? '접기' : entry.report ? '자세히' : '더 보기';
  const body = <TimelineBody entry={entry} expanded={expanded} onChooseAnswer={onChooseAnswer} />;
  const message = entry.user ? <UserMessage event={event} session={session} messageKind={kind}>{body}</UserMessage>
    : <AssistantMessage event={event} session={session} messageKind={kind}>{body}</AssistantMessage>;
  return fold ? <TouchableWithoutFeedback testID={`card-fold-${entry.id}`} accessibilityRole="button" accessibilityLabel={`${entry.id} ${label}`}
    onPress={() => setExpanded((old) => !old)}><View>{message}</View></TouchableWithoutFeedback> : message;
}

function TimelineBody({ entry, expanded, onChooseAnswer }: { entry: Entry; expanded: boolean; onChooseAnswer(answer: string): void }) {
  const t = useTokens();
  const styles = useMemo(() => cardDetailStyles(t), [t]);
  const report = entry.report;
  const preview = report ? reportSummary(report) : entry.body;
  const fold = report || entry.kind === '지시';
  const gallery = report ? reportImages(report).map((uri) => ({ uri })) : [];
  const images = gallery.slice(0, 2);
  return <View style={styles.bodyStack}>
    {!fold || (expanded && entry.kind === '지시') ? <CardRequestView request={entry.body} attachments={entry.attachments} /> : <Text style={styles.body} numberOfLines={fold && !expanded ? 3 : undefined}>{preview}</Text>}
    {images.length ? <View style={styles.thumbnails}>{images.map((source, index) => <AttachmentImage key={source.uri}
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
    : [...report.body.matchAll(/!\[[^\]]*\]\((https?:\/\/[^\s)]+)(?:\s+"[^"]*")?\)/g)].map((match) => match[1]);
}
export function reportSummary(report: CardReport): string {
  const text = report.format === 'html'
    ? report.body.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<\/(p|div|h[1-6])>/gi, '\n\n').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    : report.body;
  return text.trim().replace(/!\[[^\]]*\]\([^)]*\)/g, '').trim();
}
