import { create } from 'zustand';
import type { CardDetail, CardDto } from '../api/cardTypes';
import { captureAuthScope, subscribeAuthScope } from '../lib/auth-scope';

interface CardState {
  rows: Record<string, CardDto>;
  seq: number;
  rowSeq: Record<string, number>;
  listTicket: Record<string, number>;
  details: Record<string, CardDetail>;
  pendingItemConfirmations: Record<string, Record<number, { confirmed: boolean; requestId: string }>>;
  putCard(card: CardDto): void;
  putCards(cards: readonly CardDto[], snapshotSeq: number, ticket?: number): void;
  putDetail(detail: CardDetail): void;
  putMutationCard(card: CardDto): void;
  beginItemConfirmation(cardId: string, itemId: number, confirmed: boolean, requestId: string): boolean;
  finishItemConfirmation(cardId: string, itemId: number, requestId: string): void;
}
let nextListTicket = 0;

export const useCardStore = create<CardState>((set, get) => ({
  rows: {}, seq: 0, rowSeq: {}, listTicket: {}, details: {}, pendingItemConfirmations: {},
  putCard: (card) => set((state) => {
    if (state.rows[card.id]?.version > card.version) return state;
    const seq = state.seq + 1;
    const listTicket = { ...state.listTicket };
    delete listTicket[card.id];
    return {
      seq,
      listTicket,
      rowSeq: { ...state.rowSeq, [card.id]: seq },
      rows: { ...state.rows, [card.id]: card },
    };
  }),
  putCards: (cards, snapshotSeq, ticket = ++nextListTicket) => set((state) => {
    const rows = { ...state.rows };
    const rowSeq = { ...state.rowSeq };
    const listTicket = { ...state.listTicket };
    const details = { ...state.details };
    let seq = state.seq;
    for (const card of cards) {
      const currentVersion = rows[card.id]?.version ?? 0;
      if (currentVersion > card.version) continue;
      // 직접 변경과 더 늦게 시작한 목록은 이전 요청보다 우선한다.
      const previousTicket = state.listTicket?.[card.id];
      if (currentVersion === card.version && (state.rowSeq[card.id] ?? 0) > snapshotSeq
        && (previousTicket === undefined || previousTicket > ticket)) continue;
      seq += 1;
      rows[card.id] = card;
      rowSeq[card.id] = seq;
      listTicket[card.id] = ticket;
      const detail = details[card.id];
      if (detail) details[card.id] = { ...detail, card };
    }
    return seq === state.seq ? state : { seq, rows, rowSeq, listTicket, details };
  }),
  putDetail: (detail) => set((state) => {
    if (state.rows[detail.card.id]?.version > detail.card.version) return state;
    const seq = state.seq + 1;
    const listTicket = { ...state.listTicket };
    delete listTicket[detail.card.id];
    return {
      seq,
      listTicket,
      rowSeq: { ...state.rowSeq, [detail.card.id]: seq },
      rows: { ...state.rows, [detail.card.id]: detail.card },
      details: { ...state.details, [detail.card.id]: detail },
    };
  }),
  putMutationCard: (card) => set((state) => {
    const detail = state.details[card.id];
    const newestVersion = Math.max(state.rows[card.id]?.version ?? -1, detail?.card.version ?? -1);
    if (newestVersion > card.version) return state;
    const seq = state.seq + 1;
    const listTicket = { ...state.listTicket };
    delete listTicket[card.id];
    return {
      seq,
      listTicket,
      rowSeq: { ...state.rowSeq, [card.id]: seq },
      rows: { ...state.rows, [card.id]: card },
      ...(detail ? { details: { ...state.details, [card.id]: { ...detail, card } } } : {}),
    };
  }),
  beginItemConfirmation: (cardId, itemId, confirmed, requestId) => {
    if (get().pendingItemConfirmations[cardId]?.[itemId]) return false;
    set((state) => ({ pendingItemConfirmations: {
      ...state.pendingItemConfirmations,
      [cardId]: { ...state.pendingItemConfirmations[cardId], [itemId]: { confirmed, requestId } },
    } }));
    return true;
  },
  finishItemConfirmation: (cardId, itemId, requestId) => set((state) => {
    const cardPending = state.pendingItemConfirmations[cardId];
    if (cardPending?.[itemId]?.requestId !== requestId) return state;
    const remaining = { ...cardPending };
    delete remaining[itemId];
    const pendingItemConfirmations = { ...state.pendingItemConfirmations };
    if (Object.keys(remaining).length) pendingItemConfirmations[cardId] = remaining;
    else delete pendingItemConfirmations[cardId];
    return { pendingItemConfirmations };
  }),
}));
subscribeAuthScope(() => useCardStore.setState({ rows: {}, seq: 0, rowSeq: {}, listTicket: {}, details: {}, pendingItemConfirmations: {} }));

export function beginCardListRequest() {
  return { seq: useCardStore.getState().seq, ticket: ++nextListTicket };
}

export async function refreshCard(
  api: { getCard(id: string): Promise<CardDetail> }, id: string,
) {
  const scope = captureAuthScope().generation;
  const detail = await api.getCard(id);
  if (captureAuthScope().generation === scope) useCardStore.getState().putDetail(detail);
  return detail;
}

export function mergeCardRows(
  initial: readonly CardDto[],
  updates: Record<string, CardDto>,
  snapshot?: { seq: number; rowSeq: Record<string, number> },
) {
  const rows = new Map(initial.map((card) => [card.id, card]));
  for (const card of Object.values(updates)) {
    if (rows.has(card.id)) {
      if (rows.get(card.id)!.version <= card.version) rows.set(card.id, card);
    } else if (!snapshot || (snapshot.rowSeq[card.id] ?? 0) > snapshot.seq) {
      rows.set(card.id, card);
    }
  }
  return [...rows.values()].filter((card) => !card.archived);
}
