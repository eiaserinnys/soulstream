import { useEffect, useMemo, useRef, useState } from 'react';
import type { CardDetail } from '../api/cardTypes';
import { replaceEqualDeep } from '../lib/structural-sharing';
import type { ApiClient } from '../api/client';
import { refreshCard, useCardStore } from '../store/cardStore';
import { useAuthScopeGeneration } from '../lib/auth-scope';

export function useCardDetail(api: ApiClient | null, cardId: string | null) {
  const received = useCardStore((state) => cardId ? state.details[cardId] : undefined);
  const previous = useRef<CardDetail | undefined>(undefined);
  const detail = useMemo(() => {
    const shared = replaceEqualDeep(previous.current, received);
    previous.current = shared;
    return shared;
  }, [received]);
  const [error, setError] = useState<string | null>(null);
  const scope = useAuthScopeGeneration();
  useEffect(() => {
    setError(null);
    if (!api || !cardId) return;
    let cancelled = false;
    void refreshCard(api, cardId).catch((cause) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => { cancelled = true; };
  }, [api, cardId, scope]);
  return { detail, error };
}
