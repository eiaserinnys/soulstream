import type { HistoricalMessage } from '../api/historyTypes';

// The existing public dialogue sample, shared by timeline and RN web SSE review.
export const dialogueMessages: HistoricalMessage[] = [
  { id: 2, parent_event_id: 1, event_type: 'assistant_message',
    payload: { text: '담당 세션의 대화입니다. 카드 요청과 입력창을 함께 확인할 수 있습니다.' },
    created_at: '2026-10-03T16:00:01Z' },
  { id: 1, parent_event_id: null, event_type: 'user_message',
    payload: { text: '이 카드의 담당 대화를 오른쪽에서 보여주세요.' },
    created_at: '2026-10-03T16:00:00Z' },
];

// A finite public response consumed by the real react-native-sse XMLHttpRequest.
// This exercises RN web review only, not the production server's live stream.
export function reviewSessionEventsUrl(sessionId: string, lastEventId?: string): string {
  const frames = [...dialogueMessages].reverse()
    .filter(event => event.id > Number(lastEventId ?? 0))
    .map(event => `id: ${event.id}\nevent: ${event.event_type}\ndata: ${JSON.stringify({
      ...event.payload, session_id: sessionId, _event_id: event.id,
      parent_event_id: event.parent_event_id, timestamp: event.created_at,
    })}\n\n`);
  frames.push(`event: history_sync\ndata: ${JSON.stringify({
    session_id: sessionId, last_event_id: dialogueMessages[0].id,
  })}\n\n`);
  return `data:text/event-stream;charset=utf-8,${encodeURIComponent(frames.join(''))}`;
}

export function contentLinkReviewSessionEventsUrl(
  sessionId: string,
  lastEventId?: string,
  origin = 'https://soulstream.test',
): string {
  const messages: HistoricalMessage[] = [
    { id: 1, parent_event_id: null, event_type: 'user_message',
      payload: { text: '문서와 첨부 링크를 확인합니다.' }, created_at: '2026-10-12T00:00:00Z' },
    { id: 2, parent_event_id: 1, event_type: 'assistant_message',
      payload: { text: `[문서 보기](${origin}/api/markdown-documents/public-content-document) · [느린 문서 보기](${origin}/api/markdown-documents/public-content-document) · [이미지 보기](${origin}/api/attachments/files?nodeId=public-node&path=%2Ftmp%2Fsample.png) · [카드 보기](${origin}/?card=public-shell-card-owner) · [외부 링크](https://example.com)` },
      created_at: '2026-10-12T00:00:01Z' },
  ];
  const frames = messages
    .filter(event => event.id > Number(lastEventId ?? 0))
    .map(event => `id: ${event.id}\nevent: ${event.event_type}\ndata: ${JSON.stringify({
      ...event.payload, session_id: sessionId, _event_id: event.id,
      parent_event_id: event.parent_event_id, timestamp: event.created_at,
    })}\n\n`);
  frames.push(`event: history_sync\ndata: ${JSON.stringify({ session_id: sessionId, last_event_id: messages[1].id })}\n\n`);
  return `data:text/event-stream;charset=utf-8,${encodeURIComponent(frames.join(''))}`;
}
