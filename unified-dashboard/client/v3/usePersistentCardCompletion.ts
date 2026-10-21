import { useCallback, useEffect, useRef, useState } from 'react';
import type { PersistentReportEntry } from '@seosoyoung/soul-ui';
import { useCardStore } from '@seosoyoung/soul-ui/cards/card-store';

export const CARD_COMPLETION_UNDO_MS = 5000;
export type CardTransition = (cardId: string, status: 'done' | 'review') => Promise<void>;
type CompletionEntry = Pick<PersistentReportEntry, 'card_numbers'> & { card_id: string };
type RecentCompletion = { cardId: string; label: string };

class CardStatusChangedError extends Error {}

async function transitionCard(cardId: string, status: 'done' | 'review', expectedStatus: 'review' | 'done') {
  const store = useCardStore.getState();
  const detail = await store.loadCard(cardId);
  if (detail.card.status !== expectedStatus) throw new CardStatusChangedError();
  const next = await store.mutate(cardId, '/status', { status, expectedVersion: detail.card.version });
  return { version: next.card.version };
}

export function usePersistentCardCompletion(notify: (text: string) => void, cardTransition?: CardTransition) {
  const [recent, setRecent] = useState<RecentCompletion | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const recentRef = useRef(recent);
  recentRef.current = recent;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);
  useEffect(() => clearTimer, [clearTimer]);

  const runTransition = useCallback(async (cardId: string, status: 'done' | 'review', expectedStatus: 'review' | 'done') => {
    if (cardTransition) await cardTransition(cardId, status);
    else await transitionCard(cardId, status, expectedStatus);
  }, [cardTransition]);

  const complete = useCallback(async (entry: CompletionEntry) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await runTransition(entry.card_id, 'done', 'review');
      clearTimer();
      const next = { cardId: entry.card_id, label: entry.card_numbers[0] === undefined ? '완료됨' : `#${entry.card_numbers[0]} 완료됨` };
      recentRef.current = next;
      setRecent(next);
      timer.current = setTimeout(() => {
        recentRef.current = null;
        timer.current = null;
        setRecent(null);
      }, CARD_COMPLETION_UNDO_MS);
    } catch (error) {
      notify(error instanceof CardStatusChangedError ? '카드 상태가 바뀌었어.' : '카드를 완료하지 못했어.');
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [clearTimer, notify, runTransition]);

  const undo = useCallback(async () => {
    const current = recentRef.current;
    if (!current || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await runTransition(current.cardId, 'review', 'done');
      clearTimer();
      recentRef.current = null;
      setRecent(null);
    } catch (error) {
      notify(error instanceof CardStatusChangedError ? '카드 상태가 바뀌었어.' : '되돌리지 못했어.');
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [clearTimer, notify, runTransition]);

  return { recent, busy, complete, undo };
}
