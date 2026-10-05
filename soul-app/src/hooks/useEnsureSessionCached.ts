import { useEffect, useMemo, useRef } from 'react';
import type { ApiClient } from '../api/client';
import { captureAuthScope, isAuthScopeCurrent, useAuthScopeGeneration } from '../lib/auth-scope';
import { useSessionStore } from '../store/sessionStore';

export function useEnsureSessionCached(api: ApiClient | null, sessionId: string | undefined): void {
  const scopeGeneration = useAuthScopeGeneration();
  const authScope = useMemo(() => captureAuthScope(), [scopeGeneration]);
  const cached = useSessionStore((state) => sessionId ? state.sessions[sessionId] : undefined);
  const mergeSessions = useSessionStore((state) => state.mergeSessions);
  const attemptedIdsRef = useRef({ generation: scopeGeneration, ids: new Set<string>() });
  if (attemptedIdsRef.current.generation !== scopeGeneration) {
    attemptedIdsRef.current = { generation: scopeGeneration, ids: new Set() };
  }

  useEffect(() => {
    if (!api || !sessionId || cached || attemptedIdsRef.current.ids.has(sessionId)) return;
    attemptedIdsRef.current.ids.add(sessionId);
    void api.getSessionsByIds([sessionId])
      .then((rows) => {
        if (isAuthScopeCurrent(authScope)) mergeSessions(rows);
      })
      .catch((error) => {
        if (isAuthScopeCurrent(authScope)) {
          console.warn('[ChatBody] session hydration failed:', error);
        }
      });
  }, [api, authScope, cached, mergeSessions, scopeGeneration, sessionId]);
}
