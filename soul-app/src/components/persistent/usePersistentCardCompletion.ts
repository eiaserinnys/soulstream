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
  complete(entry: PersistentReportEntry): Promise<boolean>;
  undo(): Promise<boolean>;
}

export function usePersistentCardCompletion(api: ApiClient | null): CardCompletion {
  const [recent, setRecent] = useState<CardCompletionRecent | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const mounted = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const completedCard = useRef<CardDto | null>(null);

  const clearRecent = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    completedCard.current = null;
    if (mounted.current) setRecent(null);
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
  }, []);

  const complete = useCallback(async (entry: PersistentReportEntry): Promise<boolean> => {
    if (!api || busyRef.current || !isReviewCardEntry(entry)) return false;
    const source = persistentReportStatusCard(entry);
    if (!source) return false;

    busyRef.current = true;
    setBusy(true);
    try {
      const result = await performCardTransition(api, source, 'done', cardOperationId(), undefined, () => mounted.current);
      if (!result.card) return false;
      if (!mounted.current) return false;

      if (timer.current) clearTimeout(timer.current);
      completedCard.current = result.card;
      const number = entry.card_numbers[0] ?? null;
      const expiresAt = Date.now() + CARD_COMPLETION_UNDO_MS;
      const nextRecent = { cardId: result.card.id, number, label: number === null ? '완료됨' : `#${number} 완료됨`, expiresAt };
      setRecent(nextRecent);
      timer.current = setTimeout(() => {
        timer.current = null;
        completedCard.current = null;
        if (mounted.current) setRecent(null);
      }, CARD_COMPLETION_UNDO_MS);
      return true;
    } catch {
      return false;
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  }, [api]);

  const undo = useCallback(async (): Promise<boolean> => {
    const source = completedCard.current;
    if (!api || busyRef.current || !source) return false;

    busyRef.current = true;
    setBusy(true);
    try {
      const result = await performCardTransition(api, source, 'review', cardOperationId(), undefined, () => mounted.current);
      if (!result.card || !mounted.current) return false;
      clearRecent();
      return true;
    } catch {
      return false;
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  }, [api, clearRecent]);

  return { recent, busy, complete, undo };
}
