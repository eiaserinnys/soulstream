import { useTranslation } from "react-i18next";
import { useEffect, useMemo, useRef } from 'react';
import { useAuth } from '@seosoyoung/soul-ui';
import { parseSessionSearchIntent } from '@soulstream/search-contract';
import { createPersistentSessionsApi, type PersistentSessionList } from '../lib/persistent-sessions';
import { readPersistentSessionDevicePreferences } from '../lib/persistent-session-device-preferences';
import { navigateDashboard } from '../dashboard-navigation';
import { useV3Notifications } from './use-v3-notifications';
import { readDashboardLinkIntent } from './dashboard-link-intent';

export function usePersistentSessionStartup(pathname: string) {
  const { i18n } = useTranslation();
  const api = useMemo(() => createPersistentSessionsApi(fetch, i18n.t), [i18n]);
  const { user, isLoading, isAuthenticated, refreshAuthStatus } = useAuth();
  const { toast, notify } = useV3Notifications(refreshAuthStatus);
  const consumed = useRef(false);
  const request = useRef<Promise<PersistentSessionList> | null>(null);
  useEffect(() => {
    if (consumed.current) return;
    const hasDashboardIntent = readDashboardLinkIntent(window.location, [window.location.origin]);
    if (pathname !== '/' || parseSessionSearchIntent(window.location.href) || hasDashboardIntent) { consumed.current = true; return; }
    if (isLoading || !isAuthenticated || !user?.email) return;
    const preferences = readPersistentSessionDevicePreferences(user.email);
    if (!preferences.openOnStart) { consumed.current = true; return; }
    let current = true;
    request.current ??= api.list();
    void request.current.then(({ sessions }) => {
      if (!current || consumed.current) return;
      consumed.current = true;
      // 0개여도 /persistent로 보낸다. 빈 상태는 그 화면이 그린다.
      const target = sessions.length === 1 ? sessions[0] : sessions.find(session => session.session_id === preferences.lastSessionId);
      navigateDashboard(target ? `/persistent/${encodeURIComponent(target.session_id)}` : '/persistent', true);
    }).catch(error => {
      if (!current || consumed.current) return;
      consumed.current = true;
      notify(error instanceof Error ? error.message : String(error));
    });
    return () => { current = false; };
  }, [api, isAuthenticated, isLoading, notify, pathname, user?.email]);
  return toast;
}
