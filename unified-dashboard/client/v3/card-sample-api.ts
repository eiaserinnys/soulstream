import { useLayoutEffect, type MutableRefObject } from 'react';
import type { CardComment, CardDetail } from '@seosoyoung/soul-ui/cards/card-types';

/**
 * 카드 #1197 검수 표본: 카드 API 응답만 바꾼다. 화면 부품은 운영과 같은 경로로 카드를 읽고 보낸다.
 * 답과 커멘트는 ref의 상세를 고친 뒤 돌려주므로, 이어지는 loadCard가 저장된 결과를 읽는다.
 */
export function useCardApiSample(detailRef: MutableRefObject<CardDetail>) {
  useLayoutEffect(() => {
    const original = window.fetch;
    const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    window.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof Request ? input.url : String(input), window.location.origin);
      if (!url.pathname.startsWith('/api/cards')) return original(input, init);
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
      const detail = detailRef.current;
      const cardId = detail.card.id;
      const answerMatch = url.pathname.match(/^\/api\/cards\/([^/]+)\/questions\/([^/]+)\/answer$/);
      if (method === 'GET' && url.pathname === `/api/cards/${encodeURIComponent(cardId)}`) return respond(detail);
      if (method === 'GET' && url.pathname === '/api/cards') return respond({ cards: [detail.card] });
      if (method === 'POST' && answerMatch) {
        const body = JSON.parse(String(init?.body ?? '{}')) as { mode?: string; option?: string; answer?: string };
        const questionId = decodeURIComponent(answerMatch[2]!);
        const answer = body.mode === 'choice' ? body.option ?? '' : body.answer ?? '';
        detailRef.current = {
          ...detail,
          card: { ...detail.card, version: detail.card.version + 1 },
          questions: detail.questions.map(question => question.id === questionId
            ? { ...question, answer, selectedOption: body.mode === 'choice' ? answer : question.selectedOption, answeredAt: new Date().toISOString() }
            : question),
        };
        return respond({ ok: true });
      }
      if (method === 'POST' && url.pathname === `/api/cards/${encodeURIComponent(cardId)}/comments`) {
        const body = JSON.parse(String(init?.body ?? '{}')) as { body?: string; idempotencyKey?: string; itemId?: number; questionId?: string };
        const comment: CardComment = {
          id: body.idempotencyKey ?? crypto.randomUUID(), cardId, authorKind: 'user', authorId: 'sample', sessionId: null, kind: 'comment',
          ...(body.itemId === undefined ? {} : { itemId: body.itemId }),
          ...(body.questionId === undefined ? {} : { questionId: body.questionId }),
          body: body.body ?? '', createdAt: new Date().toISOString(),
        };
        detailRef.current = { ...detail, comments: [...(detail.comments ?? []), comment] };
        return respond(comment);
      }
      return respond({ ok: true });
    };
    return () => { window.fetch = original; };
  }, [detailRef]);
}
