import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiClient } from '../../api/client';
import type { CardDto } from '../../api/cardTypes';
import type { PersistentReportEntry } from '../../api/types';
import { cardOperationId } from '../../hooks/useCardActions';
import { performCardTransition } from '../../lib/card-transition';
import { isReviewCardEntry, persistentReportStatusCard } from '../../lib/persistent-report-card';

export const CARD_COMPLETION_UNDO_MS = 5000;

export interface CardCompletionRecent {
  cardId: string;
  number: number | null;
  label: string;
  expiresAt: number;
}

export interface CardCompletion {
  recent: CardCompletionRecent | null;
  busy: boolean;
  complete(entry: PersistentReportEntry, currentEntries?: PersistentReportEntry[]): Promise<boolean>;
  undo(): Promise<boolean>;
  filterEntries?(entries: PersistentReportEntry[]): PersistentReportEntry[];
}

interface CompletedRecord {
  key: string;
  cardId: string;
  updatedAt: string;
  card: CardDto;
  entry: PersistentReportEntry;
  nextKey: string | null;
}

interface RestoredRecord {
  key: string;
  cardId: string;
  entry: PersistentReportEntry;
  updatedAt: string;
  nextKey: string | null;
}

export function usePersistentCardCompletion(api: ApiClient | null): CardCompletion {
  const [recent, setRecent] = useState<CardCompletionRecent | null>(null);
  const [busy, setBusy] = useState(false);
  const [, bump] = useState(0);
  const busyRef = useRef(false);
  const mounted = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const completedCard = useRef<CardDto | null>(null);
  const recentRef = useRef<CardCompletionRecent | null>(null);
  const lastEntriesRef = useRef<PersistentReportEntry[] | null>(null);
  const completedByKey = useRef(new Map<string, CompletedRecord>());
  const restoredByKey = useRef(new Map<string, RestoredRecord>());

  const stopTimer = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const clearRecent = useCallback(() => {
    stopTimer();
    completedCard.current = null;
    recentRef.current = null;
    if (mounted.current) setRecent(null);
  }, [stopTimer]);

  const restorePreviousRecent = useCallback((prevRecent: CardCompletionRecent | null, prevCard: CardDto | null) => {
    if (!prevRecent || !prevCard) {
      completedCard.current = null;
      recentRef.current = null;
      if (mounted.current) setRecent(null);
      return;
    }
    const remaining = prevRecent.expiresAt - Date.now();
    if (remaining <= 0) {
      completedCard.current = null;
      recentRef.current = null;
      if (mounted.current) setRecent(null);
      return;
    }
    completedCard.current = prevCard;
    recentRef.current = prevRecent;
    if (mounted.current) setRecent(prevRecent);
    timer.current = setTimeout(() => {
      timer.current = null;
      completedCard.current = null;
      recentRef.current = null;
      if (mounted.current) setRecent(null);
    }, remaining);
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
  }, []);

  const complete = useCallback(async (entry: PersistentReportEntry, currentEntries?: PersistentReportEntry[]): Promise<boolean> => {
    if (!api || busyRef.current || !isReviewCardEntry(entry)) return false;
    const source = persistentReportStatusCard(entry);
    if (!source) return false;

    busyRef.current = true;
    setBusy(true);
    const prevRecent = recentRef.current;
    const prevCard = completedCard.current;
    stopTimer();
    try {
      const result = await performCardTransition(api, source, 'done', cardOperationId(), undefined, () => mounted.current);
      if (!result.card) {
        if (mounted.current) restorePreviousRecent(prevRecent, prevCard);
        return false;
      }
      if (!mounted.current) return false;

      const sourceEntries = currentEntries ?? lastEntriesRef.current;
      const sourceIndex = sourceEntries ? sourceEntries.findIndex(item => item.key === entry.key) : -1;
      const nextKey = sourceEntries && sourceIndex >= 0 ? sourceEntries[sourceIndex + 1]?.key ?? null : null;

      completedByKey.current.set(entry.key, {
        key: entry.key, cardId: result.card.id, updatedAt: entry.updated_at, card: result.card, entry, nextKey,
      });
      restoredByKey.current.delete(entry.key);

      completedCard.current = result.card;
      const number = entry.card_numbers[0] ?? null;
      const expiresAt = Date.now() + CARD_COMPLETION_UNDO_MS;
      const nextRecent = { cardId: result.card.id, number, label: number === null ? '완료됨' : `#${number} 완료됨`, expiresAt };
      recentRef.current = nextRecent;
      setRecent(nextRecent);
      bump(value => value + 1);
      timer.current = setTimeout(() => {
        timer.current = null;
        completedCard.current = null;
        recentRef.current = null;
        if (mounted.current) setRecent(null);
      }, CARD_COMPLETION_UNDO_MS);
      return true;
    } catch {
      if (mounted.current) restorePreviousRecent(prevRecent, prevCard);
      return false;
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  }, [api, restorePreviousRecent, stopTimer]);

  const undo = useCallback(async (): Promise<boolean> => {
    const source = completedCard.current;
    if (!api || busyRef.current || !source) return false;

    busyRef.current = true;
    setBusy(true);
    const prevRecent = recentRef.current;
    stopTimer();
    try {
      const result = await performCardTransition(api, source, 'review', cardOperationId(), undefined, () => mounted.current);
      if (!result.card) {
        if (mounted.current) restorePreviousRecent(prevRecent, source);
        return false;
      }
      if (!mounted.current) return false;

      const completed = Array.from(completedByKey.current.values()).find(item => item.cardId === source.id);
      if (completed) {
        completedByKey.current.delete(completed.key);
        restoredByKey.current.set(completed.key, {
          key: completed.key, cardId: source.id, entry: { ...completed.entry, card_status: 'review' },
          updatedAt: completed.updatedAt, nextKey: completed.nextKey,
        });
      }

      clearRecent();
      bump(value => value + 1);
      return true;
    } catch {
      if (mounted.current) restorePreviousRecent(prevRecent, source);
      return false;
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  }, [api, clearRecent, restorePreviousRecent, stopTimer]);

  const filterEntries = useCallback((rawEntries: PersistentReportEntry[]): PersistentReportEntry[] => {
    lastEntriesRef.current = rawEntries;
    let changed = false;

    for (const key of Array.from(completedByKey.current.keys())) {
      const record = completedByKey.current.get(key)!;
      const live = rawEntries.find(item => item.key === key);
      if (live && live.updated_at !== record.updatedAt) {
        completedByKey.current.delete(key);
        changed = true;
      }
    }
    // Callers may project the same list more than once (report hook, pager) and the
    // previous projection can be their input. Only a fresh server publication of the
    // restored entry ends the restoration.
    for (const key of Array.from(restoredByKey.current.keys())) {
      const record = restoredByKey.current.get(key)!;
      const live = rawEntries.find(item => item.key === key);
      if (live && live !== record.entry && live.updated_at !== record.updatedAt) {
        restoredByKey.current.delete(key);
        changed = true;
      }
    }

    const visible = rawEntries.filter(item => {
      const record = completedByKey.current.get(item.key);
      const hidden = Boolean(record && record.updatedAt === item.updated_at);
      if (hidden) changed = true;
      return !hidden;
    });

    let result = visible;
    for (const record of restoredByKey.current.values()) {
      if (result.some(item => item.key === record.key)) continue;
      const anchor = record.nextKey === null ? -1 : result.findIndex(item => item.key === record.nextKey);
      const next = [...result];
      next.splice(anchor < 0 ? next.length : anchor, 0, record.entry);
      result = next;
      changed = true;
    }

    return changed ? result : rawEntries;
  }, []);

  return { recent, busy, complete, undo, filterEntries };
}
