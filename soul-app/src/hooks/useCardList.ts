import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import type { ApiClient } from '../api/client';
import type { CardDto } from '../api/cardTypes';
import { captureAuthScope, useAuthScopeGeneration } from '../lib/auth-scope';
import {
  cancelCardRefresh,
  createCardRefreshWindow,
  scheduleCardRefresh,
} from '../lib/card-refresh-window';
import { mergeCardRows, useCardStore } from '../store/cardStore';
import { usePlannerStore } from '../store/plannerStore';

/** Board inventory is the authenticated list, independent of the daily feed. */
export function useCardList(api: ApiClient | null, folderId?: string, enabled = true) {
  const scope = useAuthScopeGeneration();
  const owner = `${scope}:${folderId ?? 'global'}`;
  const [retry, setRetry] = useState(0);
  const [state, setState] = useState<{ owner: string; cards: CardDto[]; snapshotSeq: number; hasSnapshot: boolean; loading: boolean; error: string | null }>({ owner, cards: [], snapshotSeq: 0, hasSnapshot: false, loading: !!api, error: null });
  // 폴더·재생 무효화는 즉시, 카드 갱신은 카드 목록 몫만 한 창으로 묶는다.
  const structuralInvalidation = usePlannerStore((s) => s.invalidation.folder + s.invalidation.replay);
  const cardInvalidation = usePlannerStore((s) => s.invalidation.card);
  const updates = useCardStore((s) => s.rows);
  const rowSeq = useCardStore((s) => s.rowSeq);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const generationRef = useRef(0);
  const inFlightRef = useRef<number | null>(null);
  const queuedRef = useRef(false);
  const refreshWindowRef = useRef(createCardRefreshWindow());
  const loadRef = useRef<() => void>(() => {});
  const previousCardInvalidation = useRef(cardInvalidation);

  const load = useCallback(() => {
    if (!api) return;
    if (!enabledRef.current) return;
    previousCardInvalidation.current = usePlannerStore.getState().invalidation.card;
    cancelCardRefresh(refreshWindowRef.current);
    queuedRef.current = false;
    const generation = ++generationRef.current;
    inFlightRef.current = generation;
    setState((previous) => ({ owner, cards: previous.owner === owner ? previous.cards : [], snapshotSeq: previous.owner === owner ? previous.snapshotSeq : 0, hasSnapshot: previous.owner === owner ? previous.hasSnapshot : false, loading: true, error: null }));
    void (async () => {
      try {
        // 스냅숏 경계는 요청을 시작한 시점이다. 요청 전에 스토어에만 있던 행은 목록에 없으면 버리고,
        // 응답을 기다리는 동안 들어온 행은 경계 뒤로 남겨 목록에 없어도 보이게 한다.
        const snapshotSeq = useCardStore.getState().seq;
        const result = await api.listCards(folderId,{includeCompleted:false});
        if (generationRef.current !== generation || captureAuthScope().generation !== scope) return;
        // 목록 응답도 전역 행을 최신 버전으로 맞춘 뒤 그 행을 기준으로 첫 스냅숏을 연다.
        useCardStore.getState().putCards(result.cards, snapshotSeq);
        setState({ owner, cards: result.cards, snapshotSeq, hasSnapshot: true, loading: false, error: null });
      } catch (cause) {
        if (generationRef.current !== generation || captureAuthScope().generation !== scope) return;
        setState((previous) => ({ ...previous, loading: false, error: cause instanceof Error ? cause.message : String(cause) }));
      } finally {
        if (inFlightRef.current === generation) {
          inFlightRef.current = null;
          if (queuedRef.current && enabledRef.current) loadRef.current();
        }
      }
    })();
  }, [api, folderId, owner, scope]);
  loadRef.current = load;

  // 최초 조회, 폴더 전환, 폴더·재생 무효화, 다시 시도는 그대로 즉시 읽는다.
  useEffect(() => {
    void load();
  }, [load, retry, structuralInvalidation]);

  // 카드 갱신이 몰려 오면 마지막 사건 뒤 한 창으로 묶어 한 번만 읽는다.
  useEffect(() => {
    if (previousCardInvalidation.current === cardInvalidation) return;
    previousCardInvalidation.current = cardInvalidation;
    if (!enabledRef.current) {
      cancelCardRefresh(refreshWindowRef.current);
      return;
    }
    scheduleCardRefresh(refreshWindowRef.current, () => {
      if (inFlightRef.current !== null) queuedRef.current = true;
      else loadRef.current();
    });
  }, [cardInvalidation]);

  // 숨김에서 돌아오면 최신 목록을 한 번 읽는다.
  const wasEnabledRef = useRef(enabled);
  useEffect(() => {
    if (!enabled) {
      wasEnabledRef.current = false;
      generationRef.current += 1;
      inFlightRef.current = null;
      queuedRef.current = false;
      cancelCardRefresh(refreshWindowRef.current);
      return;
    }
    if (wasEnabledRef.current) return;
    wasEnabledRef.current = true;
    void load();
  }, [enabled, owner, load]);

  useEffect(() => {
    let wasBackgrounded = false;
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'background') wasBackgrounded = true;
      if (next === 'active' && wasBackgrounded) {
        wasBackgrounded = false;
        if (enabledRef.current) void load();
      }
    });
    return () => { generationRef.current += 1; inFlightRef.current = null; queuedRef.current = false; subscription.remove(); cancelCardRefresh(refreshWindowRef.current); };
  }, [load]);
  const cards = useMemo(() => {
    if (state.owner !== owner || !state.hasSnapshot) return [];
    const inventory = new Map(state.cards.map((card) => [card.id, card]));
    return mergeCardRows(state.cards, updates, { seq: state.snapshotSeq, rowSeq }).filter((card) => card.status!=='done' && (!folderId || card.folderId === folderId))
      .map((card) => card.latestActivity === undefined
        ? { ...card, latestActivity: inventory.get(card.id)?.latestActivity } : card);
  }, [state, owner, updates, rowSeq, folderId]);
  return { cards, loading: state.owner !== owner || state.loading, error: state.owner === owner ? state.error : null,
    refresh: () => setRetry((value) => value + 1) };
}
