import { useLayoutEffect, useRef, type MutableRefObject } from 'react';
import type { CardComment, CardDetail } from '@seosoyoung/soul-ui/cards/card-types';

/** 화면마다 서로 다른 카드 상세를 표본으로 쓰므로, 자기 카드 경로만 가로채고 나머지는 원래 fetch로 넘긴다. */
export function useCardApiSample(detailRef: MutableRefObject<CardDetail>, onAnswerSaved?: (questionId: string) => void) {
  const saved = useRef(onAnswerSaved);
  saved.current = onAnswerSaved;
  useLayoutEffect(() => {
    const original = window.fetch;
    const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    window.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof Request ? input.url : String(input), window.location.origin);
      const detail = detailRef.current;
      const cardId = detail.card.id;
      const ownCard = `/api/cards/${encodeURIComponent(cardId)}`;
      if (url.pathname !== '/api/cards' && url.pathname !== ownCard && !url.pathname.startsWith(`${ownCard}/`)) return original(input, init);
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
      const answerMatch = url.pathname.match(/^\/api\/cards\/([^/]+)\/questions\/([^/]+)\/answer$/);
      if (method === 'GET' && url.pathname === ownCard) return respond(detail);
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
        // 서버는 답 저장 커밋 뒤에 판을 다시 계산해 보낸다. 표본도 응답 전에 판 교체를 먼저 그린다.
        saved.current?.(questionId);
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
