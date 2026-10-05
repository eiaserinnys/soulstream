import { useEffect, useRef } from 'react';
import type { ApiClient } from '../api/client';
import { useSessionStore } from '../store/sessionStore';

export function useEnsureSessionCached(api: ApiClient | null, sessionId: string | undefined): void {
  const cached = useSessionStore((state) => sessionId ? state.sessions[sessionId] : undefined);
  const mergeSessions = useSessionStore((state) => state.mergeSessions);
  const attemptedIdsRef = useRef(new Set<string>());

  useEffect(() => {
    if (!api || !sessionId || cached || attemptedIdsRef.current.has(sessionId)) return;
    attemptedIdsRef.current.add(sessionId);
    void api.getSessionsByIds([sessionId])
      .then(mergeSessions)
      .catch((error) => {
        console.warn('[ChatBody] session hydration failed:', error);
      });
  }, [api, cached, mergeSessions, sessionId]);
}
