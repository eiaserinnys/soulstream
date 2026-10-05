import { create } from 'zustand';
import type { CardDetail, CardDto } from '../api/cardTypes';
import { captureAuthScope, subscribeAuthScope } from '../lib/auth-scope';

interface CardState {
  rows: Record<string, CardDto>;
  details: Record<string, CardDetail>;
  pendingItemConfirmations: Record<string, Record<number, { confirmed: boolean; requestId: string }>>;
  putCard(card: CardDto): void;
  putDetail(detail: CardDetail): void;
  putMutationCard(card: CardDto): void;
  beginItemConfirmation(cardId: string, itemId: number, confirmed: boolean, requestId: string): boolean;
  finishItemConfirmation(cardId: string, itemId: number, requestId: string): void;
}
export const useCardStore = create<CardState>((set, get) => ({
  rows: {}, details: {}, pendingItemConfirmations: {},
  putCard: (card) => set((state) => state.rows[card.id]?.version > card.version ? state : {
    rows: { ...state.rows, [card.id]: card },
  }),
  putDetail: (detail) => set((state) => state.rows[detail.card.id]?.version > detail.card.version ? state : {
    rows: { ...state.rows, [detail.card.id]: detail.card },
    details: { ...state.details, [detail.card.id]: detail },
  }),
  putMutationCard: (card) => set((state) => {
    const detail = state.details[card.id];
    const newestVersion = Math.max(state.rows[card.id]?.version ?? -1, detail?.card.version ?? -1);
    if (newestVersion > card.version) return state;
    return {
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
subscribeAuthScope(() => useCardStore.setState({ rows: {}, details: {}, pendingItemConfirmations: {} }));

export async function refreshCard(
  api: { getCard(id: string): Promise<CardDetail> }, id: string,
) {
  const scope = captureAuthScope().generation;
  const detail = await api.getCard(id);
  if (captureAuthScope().generation === scope) useCardStore.getState().putDetail(detail);
  return detail;
}

export function mergeCardRows(initial: readonly CardDto[], updates: Record<string, CardDto>) {
  const rows = new Map(initial.map((card) => [card.id, card]));
  for (const card of Object.values(updates)) {
    if (!rows.has(card.id) || rows.get(card.id)!.version <= card.version) rows.set(card.id, card);
  }
  return [...rows.values()].filter((card) => !card.archived);
}
