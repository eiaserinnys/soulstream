import { useEffect, useRef } from 'react';
import { useAuth } from '@seosoyoung/soul-ui';
import { parseSessionSearchIntent } from '@soulstream/search-contract';
import { createPersistentSessionsApi, type PersistentSessionList } from '../lib/persistent-sessions';
import { readPersistentSessionDevicePreferences } from '../lib/persistent-session-device-preferences';
import { navigateDashboard } from '../dashboard-navigation';
import { useV3Notifications } from './use-v3-notifications';

export function usePersistentSessionStartup(pathname: string) {
  const { user, isLoading, isAuthenticated, refreshAuthStatus } = useAuth();
  const { toast, notify } = useV3Notifications(refreshAuthStatus);
  const consumed = useRef(false);
  const request = useRef<Promise<PersistentSessionList> | null>(null);
  useEffect(() => {
    if (consumed.current) return;
    if (pathname !== '/' || parseSessionSearchIntent(window.location.href)) { consumed.current = true; return; }
    if (isLoading || !isAuthenticated || !user?.email) return;
    const preferences = readPersistentSessionDevicePreferences(user.email);
    if (!preferences.openOnStart) { consumed.current = true; return; }
    let current = true;
    request.current ??= createPersistentSessionsApi().list();
    void request.current.then(({ sessions }) => {
      if (!current || consumed.current) return;
      consumed.current = true;
      if (!sessions.length) return;
      const target = sessions.length === 1 ? sessions[0] : sessions.find(session => session.session_id === preferences.lastSessionId);
      navigateDashboard(target ? `/persistent/${encodeURIComponent(target.session_id)}` : '/persistent', true);
    }).catch(error => {
      if (!current || consumed.current) return;
      consumed.current = true;
      notify(error instanceof Error ? error.message : String(error));
    });
    return () => { current = false; };
  }, [isAuthenticated, isLoading, notify, pathname, user?.email]);
  return toast;
}
