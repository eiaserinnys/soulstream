import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ApiClient } from '../api/client';
import type { CardDto, CardStatus } from '../api/cardTypes';
import { cardWritePending, performCardTransition, subscribeCardWrites } from '../lib/card-transition';
import { cardOperationId, useCardActions } from './useCardActions';
import { captureAuthScope } from '../lib/auth-scope';

export function useCardTransition(api: ApiClient | null, cardId: string) {
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const { run } = useCardActions(api);
  const [error, setError] = useState<string | null>(null);
  const pending = useSyncExternalStore(subscribeCardWrites, () => cardWritePending(cardId), () => false);
  const transition = (card: CardDto, next: CardStatus, reason?: string, isActive?: () => boolean) => {
    if (!api || pending) return Promise.resolve(false);
    const scope = captureAuthScope().generation;
    setError(null);
    return run(async () => {
      try { return await performCardTransition(api, card, next, cardOperationId(), reason, () => mounted.current && (!isActive || isActive())); }
      catch (cause) {
        if (mounted.current && scope === captureAuthScope().generation && (!isActive || isActive())) setError(cause instanceof Error ? cause.message : String(cause));
        throw cause;
      }
    });
  };
  return { transition, pending, error };
}
