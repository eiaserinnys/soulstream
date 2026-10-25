import { useCallback, useEffect, useRef, useState } from 'react';
import type { PersistentReportEntry } from '@seosoyoung/soul-ui';
import { useCardStore } from '@seosoyoung/soul-ui/cards/card-store';

export const CARD_COMPLETION_UNDO_MS = 5000;
export type CardTransition = (cardId: string, status: 'done' | 'review') => Promise<void>;
export type CompletionEntry = Pick<PersistentReportEntry, 'card_numbers'> & { card_id: string; key?: string; updated_at?: string } & Partial<PersistentReportEntry>;
type RecentCompletion = { cardId: string; label: string; expiresAt: number };
type CompletedRecord = { key: string; cardId: string; updatedAt: string; snapshot: PersistentReportEntry | null; nextKey: string | null };
type RestoredRecord = { key: string; cardId: string; snapshot: PersistentReportEntry; nextKey: string | null };

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
  const [revision, bump] = useState(0);
  const busyRef = useRef(false);
  const recentRef = useRef(recent);
  recentRef.current = recent;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const completedByKey = useRef(new Map<string, CompletedRecord>());
  const restoredByKey = useRef(new Map<string, RestoredRecord>());

  const clearTimer = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);
  useEffect(() => clearTimer, [clearTimer]);

  const runTransition = useCallback(async (cardId: string, status: 'done' | 'review', expectedStatus: 'review' | 'done') => {
    if (cardTransition) await cardTransition(cardId, status);
    else await transitionCard(cardId, status, expectedStatus);
  }, [cardTransition]);

  const complete = useCallback(async (entry: CompletionEntry, currentEntries?: PersistentReportEntry[]) => {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    // The new request owns the undo row from this point on. An earlier timer
    // must not clear the previous row while this transition is still in flight.
    const previousRecent = recentRef.current;
    clearTimer();
    try {
      await runTransition(entry.card_id, 'done', 'review');
      const key = entry.key ?? `card_${entry.card_id}`;
      const sourceEntry = currentEntries?.find(item => item.key === key)
        ?? (typeof entry.title === 'string' && typeof entry.kind === 'string' ? entry as unknown as PersistentReportEntry : null);
      const sourceIndex = currentEntries ? currentEntries.findIndex(item => item.key === key) : -1;
      const nextKey = sourceIndex >= 0 && currentEntries ? (currentEntries[sourceIndex + 1]?.key ?? null) : null;
      completedByKey.current.set(key, { key, cardId: entry.card_id, updatedAt: sourceEntry?.updated_at ?? entry.updated_at ?? '', snapshot: sourceEntry, nextKey });
      restoredByKey.current.delete(key);
      const expiresAt = Date.now() + CARD_COMPLETION_UNDO_MS;
      const next = { cardId: entry.card_id, label: entry.card_numbers[0] === undefined ? '완료됨' : `#${entry.card_numbers[0]} 완료됨`, expiresAt };
      recentRef.current = next;
      setRecent(next);
      timer.current = setTimeout(() => {
        recentRef.current = null;
        timer.current = null;
        setRecent(null);
      }, CARD_COMPLETION_UNDO_MS);
      bump(value => value + 1);
      return true;
    } catch (error) {
      if (previousRecent) {
        const remaining = previousRecent.expiresAt - Date.now();
        if (remaining > 0) {
          recentRef.current = previousRecent;
          setRecent(previousRecent);
          timer.current = setTimeout(() => {
            recentRef.current = null;
            timer.current = null;
            setRecent(null);
          }, remaining);
        } else {
          recentRef.current = null;
          setRecent(null);
        }
      }
      notify(error instanceof CardStatusChangedError ? '카드 상태가 바뀌었어.' : '카드를 완료하지 못했어.');
      return false;
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
    clearTimer();
    try {
      await runTransition(current.cardId, 'review', 'done');
      const key = `card_${current.cardId}`;
      const record = completedByKey.current.get(key);
      completedByKey.current.delete(key);
      if (record?.snapshot) restoredByKey.current.set(key, { key, cardId: current.cardId, snapshot: { ...record.snapshot, card_status: 'review' }, nextKey: record.nextKey });
      recentRef.current = null;
      setRecent(null);
      bump(value => value + 1);
    } catch (error) {
      const remaining = current.expiresAt - Date.now();
      if (remaining > 0) {
        timer.current = setTimeout(() => {
          recentRef.current = null;
          timer.current = null;
          setRecent(null);
        }, remaining);
      } else {
        recentRef.current = null;
        setRecent(null);
      }
      notify(error instanceof CardStatusChangedError ? '카드 상태가 바뀌었어.' : '되돌리지 못했어.');
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [clearTimer, notify, runTransition]);

  /**
   * Projects optimistic completions and restores onto the published deck.
   * A newer server revision for the same key wins; otherwise the local edit
   * holds until the stream catches up. Unchanged input keeps its reference.
   */
  const filterEntries = useCallback((rawEntries: PersistentReportEntry[]) => {
    for (const [key, record] of completedByKey.current) {
      const match = rawEntries.find(item => item.key === key);
      if (match && match.updated_at !== record.updatedAt) completedByKey.current.delete(key);
    }
    for (const [key, record] of restoredByKey.current) {
      const match = rawEntries.find(item => item.key === key);
      if (match && match.updated_at !== record.snapshot.updated_at) restoredByKey.current.delete(key);
    }
    if (!completedByKey.current.size && !restoredByKey.current.size) return rawEntries;
    const visible = rawEntries.filter(item => !completedByKey.current.has(item.key));
    if (!restoredByKey.current.size) return visible.length === rawEntries.length ? rawEntries : visible;
    let inserted = false;
    const projected = [...visible];
    for (const [key, record] of restoredByKey.current) {
      if (projected.some(item => item.key === key)) continue;
      const anchor = record.nextKey ? projected.findIndex(item => item.key === record.nextKey) : -1;
      projected.splice(anchor >= 0 ? anchor : projected.length, 0, record.snapshot);
      inserted = true;
    }
    return inserted ? projected : (visible.length === rawEntries.length ? rawEntries : visible);
  }, []);

  return { recent, busy, complete, undo, filterEntries, revision };
}
