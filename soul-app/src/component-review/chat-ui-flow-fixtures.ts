import type { HistoricalMessage } from '../api/historyTypes';
import type { Session } from '../api/types';
import { chatUiFixtureEvent, chatUiCoverageDocument, type ChatUiExample } from './chat-ui-fixtures';
import sonnet from './chat-ui-published/sonnet.json';
import sol from './chat-ui-published/sol.json';

export const chatUiReviewSessionId = 'public-chat-ui-flow';
export function chatUiReviewSession(id = chatUiReviewSessionId): Session {
  return { agentSessionId: id, nodeId: 'public-node', agentName: 'Assistant', displayName: '채팅 UI',
    status: 'completed', backend: 'claude', sessionType: 'interactive',
    createdAt: '2026-10-12T00:00:00Z', updatedAt: '2026-10-12T00:00:00Z' };
}
export function chatUiReviewHistory(search: string): HistoricalMessage[] {
  const params = new URLSearchParams(search);
  const example: ChatUiExample = params.get('example') === 'pas' ? 'pas' : params.get('example') === 'gallery' ? 'gallery' : 'normal';
  const sample = params.get('sample'); const state = params.get('state');
  if (sample === 'selmod') return chatUiAttachmentWidthHistory();
  if (sample === 'attachments' || sample === 'attachments-missing') {
    return chatUiAttachmentReviewHistory();
  }
  const event = sample === 'published-sonnet' ? sonnet : sample === 'published-sol' ? sol : null;
  let data = event?.payload ?? chatUiFixtureEvent(example, sample === 'coverage' ? { document: chatUiCoverageDocument } : {}).data;
  if (state === 'unsupported') data = chatUiFixtureEvent(example, { schema_version: 2 }).data;
  if (state === 'invalid') data = chatUiFixtureEvent(example, { document: { schema_version: 2, body: [] } }).data;
  if (state === 'missing') data = chatUiFixtureEvent(example, { document: undefined }).data;
  if (state === 'absent') data = { content: '저장된 일반 답변이야.' };
  const messages: HistoricalMessage[] = [
    { id: 1, parent_event_id: null, event_type: 'user_message', payload: {
      text: example === 'normal' ? '인원수와 결제 조건을 바꾸며 팀 요금을 비교해 줘.' : '검수할 값과 순서를 보여줘.',
    }, created_at: '2026-10-12T00:00:00Z' },
    { id: 2, parent_event_id: 1, event_type: 'assistant_message', payload: {
      content: '같은 화면의 일반 글과 조작 화면은 같은 말풍선 줄에 놓입니다.',
    }, created_at: '2026-10-12T00:00:01Z' },
    // Original published artifacts both have id 15; each is a separate sample.
    { id: 15, parent_event_id: 1, event_type: 'assistant_message', payload: data, created_at: '2026-10-12T00:00:02Z' },
  ];
  if (sample === 'remount') messages.unshift(...Array.from({ length: 240 }, (_, index) => ({
    id: -240 + index, parent_event_id: null, event_type: 'assistant_message',
    payload: { content: `가상 목록의 앞 대화 ${index + 1}. 읽던 위치와 조작 값을 확인합니다.` },
    created_at: '2026-10-11T00:00:00Z',
  })));
  return messages.reverse();
}
export function chatUiReviewSseUrl(sessionId: string, search: string, lastId?: string) {
  const params = new URLSearchParams(search);
  const history = chatUiReviewHistory(search);
  const messages = params.get('sample') === 'sse' ? history.slice(0, 1) : history;
  const frames = [...messages].reverse().filter(event => event.id >= Number(lastId ?? 0)).map(event =>
    `id: ${event.id}\nevent: ${event.event_type}\ndata: ${JSON.stringify({ ...event.payload,
      session_id: sessionId, _event_id: event.id, parent_event_id: event.parent_event_id })}\n\n`);
  frames.push(`event: history_sync\ndata: ${JSON.stringify({ session_id: sessionId, last_event_id: Math.max(...history.map(event => event.id)) })}\n\n`);
  return `data:text/event-stream;charset=utf-8,${encodeURIComponent(frames.join(''))}`;
}
export function chatUiAttachmentReviewHistory(): HistoricalMessage[] {
  return [
    { id: 101, parent_event_id: null, event_type: 'user_message', payload: {
      text: '검토 자료를 함께 보냅니다.',
      attachment_ids: ['review-chat-image-one', 'review-chat-image-two', 'review-chat-empty-text'],
    }, created_at: '2026-10-17T00:00:00Z' },
    { id: 102, parent_event_id: 101, event_type: 'assistant_message', payload: {
      content: '이미지와 첨부 전용 응답을 같은 대화에서 확인합니다.',
      output_command_id: 'execute:review-chat-attachments',
    }, created_at: '2026-10-17T00:00:01Z' },
    { id: 103, parent_event_id: 102, event_type: 'assistant_message', payload: {
      content: '',
      attachment_ids: ['review-agent-output-image'],
      attachment_output: true,
      output_command_id: 'execute:review-chat-attachments',
    }, created_at: '2026-10-17T00:00:02Z' },
    { id: 104, parent_event_id: 103, event_type: 'complete', payload: {
      attachment_ids: ['review-agent-output-image'],
      output_command_id: 'execute:review-chat-attachments',
    }, created_at: '2026-10-17T00:00:03Z' },
    { id: 105, parent_event_id: 104, event_type: 'user_message', payload: {
      attachment_ids: ['review-chat-empty-text'],
    }, created_at: '2026-10-17T00:00:04Z' },
  ].reverse();
}

/** Three text lengths and the legacy adapter used by the existing attachment review harness. */
function chatUiAttachmentWidthHistory(): HistoricalMessage[] {
  const ids = ['review-chat-image-one', 'review-chat-image-two'];
  return [...chatUiAttachmentReviewHistory(),
    { id: 106, parent_event_id: 105, event_type: 'user_message', payload: {
      text: '짧게', attachment_ids: ids,
    }, created_at: '2026-10-17T00:00:05Z' },
    { id: 107, parent_event_id: 106, event_type: 'user_message', payload: {
      text: '예전 경로로 보낸 사진입니다.', attachments: ['/incoming/legacy-photo.png'], node_id: 'public-node',
    }, created_at: '2026-10-17T00:00:06Z' },
    { id: 108, parent_event_id: 107, event_type: 'user_message', payload: {
      text: '이 긴 문장은 사용자 말풍선이 넓어질 때 첨부 묶음의 크기가 어떻게 달라지는지 보기 위한 표본 문장입니다.', attachment_ids: ids,
    }, created_at: '2026-10-17T00:00:07Z' },
  ].sort((a, b) => b.id - a.id);
}
