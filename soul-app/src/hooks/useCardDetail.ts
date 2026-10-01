import { useEffect, useState } from 'react';
import type { ApiClient } from '../api/client';
import { refreshCard, useCardStore } from '../store/cardStore';
import { useAuthScopeGeneration } from '../lib/auth-scope';

export function useCardDetail(api: ApiClient | null, cardId: string | null) {
  const detail = useCardStore((state) => cardId ? state.details[cardId] : undefined);
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
