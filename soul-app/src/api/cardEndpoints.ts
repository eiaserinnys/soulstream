import type { ApiRequestContext } from './clientCore';
import type { CardDetail, CardDetailWire, CardMutationResult, CardDto, CardPatch, CardStatus, CardComment } from './cardTypes';

export function createCardEndpoints({ base, authFetch, readJson }: ApiRequestContext) {
  const path = (id: string) => `${base}/api/cards/${encodeURIComponent(id)}`;
  const write = (url: string, body: unknown, method = 'POST') => authFetch(url, {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }).then((response) => readJson<CardMutationResult>(response, 'cardMutation'));
  return {
    listCards: (folderId?: string) => authFetch(`${base}/api/cards${folderId ? `?${new URLSearchParams({ folderId })}` : ''}`)
      .then((response) => readJson<{ cards: CardDto[] }>(response, 'listCards')),
    getCard: (id: string) => authFetch(path(id)).then((response) => readJson<CardDetailWire>(response, 'getCard'))
      .then((raw): CardDetail => ({ ...raw, sessions: raw.sessions.map((session) => ({
        ...session, agentSessionId: session.sessionId, nodeId: session.nodeId ?? undefined,
        updatedAt: session.updatedAt ?? session.createdAt,
      })) })),
    addCardComment: (id: string, body: { body: string; idempotencyKey: string }) =>
      authFetch(`${path(id)}/comments`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        .then((response) => readJson<CardComment>(response, 'addCardComment')),
    createCard: (body: { folderId: string; title: string; request: string; queue?: boolean;
      assignee?: CardPatch['assignee']; nodeId?: string | null; modelPreset?: string | null; idempotencyKey: string }) => write(`${base}/api/cards`, body),
    setCardStatus: (id: string, status: CardStatus, expectedVersion: number, idempotencyKey: string, reason?: string) =>
      write(`${path(id)}/status`, { status, expectedVersion, idempotencyKey, ...(reason ? { reason } : {}) }),
    updateCard: (id: string, patch: CardPatch, expectedVersion: number, idempotencyKey: string) =>
      write(path(id), { ...patch, expectedVersion, idempotencyKey }, 'PATCH'),
    moveCard: (id: string, folderId: string, expectedVersion: number, idempotencyKey: string) =>
      write(`${path(id)}/move`, { folderId, expectedVersion, idempotencyKey }),
    reorderCardQueue: (id: string, afterCardId: string | null, expectedVersion: number, idempotencyKey: string) =>
      write(`${path(id)}/queue-position`, { afterCardId, expectedVersion, idempotencyKey }),
    answerCardQuestion: (id: string, questionId: string, answer: string, idempotencyKey: string) =>
      write(`${path(id)}/questions/${encodeURIComponent(questionId)}/answer`, { answer, idempotencyKey }),
  };
}
