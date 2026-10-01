import { useEffect, useMemo, useState } from 'react';
import { AppState } from 'react-native';
import type { ApiClient } from '../api/client';
import type { CardDto } from '../api/cardTypes';
import { useAuthScopeGeneration } from '../lib/auth-scope';
import { mergeCardRows, useCardStore } from '../store/cardStore';
import { usePlannerStore } from '../store/plannerStore';

/** Board inventory is the authenticated list, independent of the daily feed. */
export function useCardList(api: ApiClient | null, folderId?: string) {
  const scope = useAuthScopeGeneration();
  const owner = `${scope}:${folderId ?? 'global'}`;
  const [retry, setRetry] = useState(0);
  const [state, setState] = useState<{ owner: string; cards: CardDto[]; loading: boolean; error: string | null }>({ owner, cards: [], loading: !!api, error: null });
  const invalidation = usePlannerStore((s) => s.invalidation.folder + s.invalidation.replay);
  const updates = useCardStore((s) => s.rows);
  useEffect(() => {
    let cancelled = false;
    let wasBackgrounded = false;
    const load = async () => {
      if (!api) return;
      setState((previous) => ({ owner, cards: previous.owner === owner ? previous.cards : [], loading: true, error: null }));
      try {
        const result = await api.listCards(folderId);
        if (!cancelled) setState({ owner, cards: result.cards, loading: false, error: null });
      } catch (cause) {
        if (!cancelled) setState((previous) => ({ ...previous, loading: false, error: cause instanceof Error ? cause.message : String(cause) }));
      }
    };
    void load();
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'background') wasBackgrounded = true;
      if (next === 'active' && wasBackgrounded) { wasBackgrounded = false; void load(); }
    });
    return () => { cancelled = true; subscription.remove(); };
  }, [api, folderId, owner, retry, invalidation]);
  const cards = useMemo(() => {
    if (state.owner !== owner) return [];
    const inventory = new Map(state.cards.map((card) => [card.id, card]));
    return mergeCardRows(state.cards, updates).filter((card) => !folderId || card.folderId === folderId)
      .map((card) => card.latestActivity === undefined
        ? { ...card, latestActivity: inventory.get(card.id)?.latestActivity } : card);
  }, [state, owner, updates, folderId]);
  return { cards, loading: state.owner !== owner || state.loading, error: state.owner === owner ? state.error : null,
    refresh: () => setRetry((value) => value + 1) };
}
