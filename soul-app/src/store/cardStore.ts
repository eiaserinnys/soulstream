import { create } from 'zustand';
import type { CardDetail, CardDto } from '../api/cardTypes';
import { captureAuthScope, subscribeAuthScope } from '../lib/auth-scope';

interface CardState {
  rows: Record<string, CardDto>;
  details: Record<string, CardDetail>;
  putCard(card: CardDto): void;
  putDetail(detail: CardDetail): void;
}
export const useCardStore = create<CardState>((set) => ({
  rows: {}, details: {},
  putCard: (card) => set((state) => state.rows[card.id]?.version > card.version ? state : {
    rows: { ...state.rows, [card.id]: card },
  }),
  putDetail: (detail) => set((state) => state.rows[detail.card.id]?.version > detail.card.version ? state : {
    rows: { ...state.rows, [detail.card.id]: detail.card },
    details: { ...state.details, [detail.card.id]: detail },
  }),
}));
subscribeAuthScope(() => useCardStore.setState({ rows: {}, details: {} }));

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
