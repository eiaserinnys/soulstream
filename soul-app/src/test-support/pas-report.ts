// 카드 #1871: 보고 창 시험이 함께 쓰는 가짜 데이터와 가짜 서버. 운영 서버에는 묻지 않는다.
import type { ApiClient } from '../api/client';
import type { CardCheckItem, CardComment, CardDetail, CardDto, CardMutationResult, CardQuestion } from '../api/cardTypes';
import type { PersistentReportEntry } from '../../../packages/wire-schema/src/persistent_report';
import { cardFixture } from './cards';

export const at = (minute: number) => new Date(Date.UTC(2026, 10, 25, 1, minute)).toISOString();

export function reportEntry(patch: Partial<PersistentReportEntry> & { key: string; card_id: string }): PersistentReportEntry {
  return { kind: 'see', title: '장 제목', card_numbers: [1], context: '', action: '', options: [], state: 'open', answer: '',
    updated_at: at(30), card_status: 'review', ...patch } as PersistentReportEntry;
}

export function checkItem(patch: Partial<CardCheckItem> & { id: number }): CardCheckItem {
  return { title: '확인 항목', state: 'done', result: '됐어', evidence: [], caveat: null, rev: 1, confirmed: null, fixOpen: 0,
    reopened: null, from: null, createdAt: at(1), reportedAt: at(5), display: 'reported', ...patch };
}

export const openQuestion = (patch: Partial<CardQuestion> & { id: string; cardId: string }): CardQuestion => ({
  sessionId: 's-main', text: '어느 쪽으로 갈까?', title: '방향을 정해 주세요', kind: 'choice',
  options: ['가', '나'], optionDetails: [{ label: '가', description: '가는 빠릅니다.', recommended: true }, { label: '나', description: '나는 안전합니다.' }],
  answer: null, askedAt: at(10), ...patch });

export const comment = (patch: Partial<CardComment> & { id: string; cardId: string }): CardComment => ({
  authorKind: 'user', authorId: 'u', sessionId: null, kind: 'comment', body: '글', createdAt: at(20), ...patch });

/** 카드 하나의 상세와 그 카드 행. 가짜 서버가 읽고 쓴다. */
export function detailFixture(card: CardDto, patch: Partial<CardDetail> = {}): CardDetail {
  return { card, reports: [], questions: [], sessions: [], comments: [], notes: [], nowHistory: [], ...patch };
}

export interface FakeServer {
  api: ApiClient;
  cards: Map<string, CardDto>;
  details: Map<string, CardDetail>;
  calls: { name: string; args: unknown[] }[];
  failNext(name: string, message?: string): void;
  hang(name: string): void;
}

/** 카드 목록과 상세, 답, 커멘트, 미루기 PATCH를 받는 가짜 서버. 부른 것은 calls에 쌓인다. */
export function fakeServer(cards: CardDto[], details: Record<string, Partial<CardDetail>> = {}): FakeServer {
  const cardMap = new Map(cards.map(card => [card.id, card]));
  const detailMap = new Map(cards.map(card => [card.id, detailFixture(card, details[card.id])]));
  const calls: FakeServer['calls'] = [];
  const failures = new Map<string, string>();
  const hung = new Set<string>();
  const guard = async (name: string, args: unknown[]) => {
    calls.push({ name, args });
    if (hung.has(name)) await new Promise<never>(() => {});
    const failure = failures.get(name);
    if (failure !== undefined) { failures.delete(name); throw new Error(failure); }
  };
  const mutation = (id: string): CardMutationResult => ({ folderId: 'folder-1', card: { ...cardMap.get(id)! } });
  const api = {
    listCards: async (...args: unknown[]) => { await guard('listCards', args); return { cards: [...cardMap.values()].map(card => ({ ...card })) }; },
    getCard: async (id: string) => {
      await guard('getCard', [id]);
      const detail = detailMap.get(id);
      if (!detail) throw new Error('없는 카드');
      return { ...detail, card: { ...cardMap.get(id)!, items: detail.card.items ?? [] }, comments: [...(detail.comments ?? [])] };
    },
    updateCard: async (id: string, patch: { snoozedUntil?: string | null }, expectedVersion: number, key: string) => {
      await guard('updateCard', [id, patch, expectedVersion, key]);
      const card = cardMap.get(id)!;
      cardMap.set(id, { ...card, version: card.version + 1, snoozedUntil: patch.snoozedUntil ?? null });
      detailMap.set(id, { ...detailMap.get(id)!, card: cardMap.get(id)! });
      return mutation(id);
    },
    answerCardQuestion: async (id: string, questionId: string, input: unknown) => {
      await guard('answerCardQuestion', [id, questionId, input]);
      return mutation(id);
    },
    addCardComment: async (id: string, input: { body: string; itemId?: number; questionId?: string; idempotencyKey: string }) => {
      await guard('addCardComment', [id, input]);
      return comment({ id: input.idempotencyKey, cardId: id, body: input.body, itemId: input.itemId, questionId: input.questionId });
    },
    confirmCardItem: async (id: string, ...rest: unknown[]) => { await guard('confirmCardItem', [id, ...rest]); return mutation(id); },
    setCardStatus: async (id: string, status: CardDto['status'], expectedVersion: number) => {
      await guard('setCardStatus', [id, status, expectedVersion]);
      const card = cardMap.get(id)!;
      cardMap.set(id, { ...card, status, version: card.version + 1 });
      return mutation(id);
    },
  } as unknown as ApiClient;
  return { api, cards: cardMap, details: detailMap, calls,
    failNext: (name, message = '서버가 거절했어') => { failures.set(name, message); },
    hang: name => { hung.add(name); } };
}

export const reviewCard = (id: string, number: number, patch: Partial<CardDto> = {}) =>
  cardFixture({ id, number, status: 'review', title: `${number}번 카드`, request: '요청 원문', assigneeKind: 'session',
    assigneeSessionId: 's-main', createdAt: at(0), updatedAt: at(30), ...patch });
