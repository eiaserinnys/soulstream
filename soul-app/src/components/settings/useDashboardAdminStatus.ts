import { useEffect, useState } from 'react';
import { createApiClient } from '../../api/client';
import { captureAuthScope, isAuthScopeCurrent } from '../../lib/auth-scope';
import { useAuthStore } from '../../store/authStore';
import { useSettingsStore } from '../../store/settingsStore';

export function useDashboardAdminStatus(enabled = true): boolean {
  const serverUrl = useSettingsStore((state) => state.serverUrl);
  const jwt = useAuthStore((state) => state.jwt);
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setIsAdmin(false);
    if (!enabled || !serverUrl || !jwt) {
      return () => {
        cancelled = true;
      };
    }

    const scope = captureAuthScope();
    createApiClient(serverUrl, { authScope: scope })
      .getAuthStatus()
      .then((status) => {
        if (!cancelled && isAuthScopeCurrent(scope)) {
          setIsAdmin(status.user?.isAdmin === true);
        }
      })
      .catch(() => {
        if (!cancelled && isAuthScopeCurrent(scope)) setIsAdmin(false);
      });

    return () => {
      cancelled = true;
    };
  }, [enabled, jwt, serverUrl]);

  return isAdmin;
}
