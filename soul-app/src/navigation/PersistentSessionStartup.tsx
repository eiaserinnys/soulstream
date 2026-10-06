import { useEffect, useRef } from 'react';
import { decodeAuthJwt } from '../auth/jwt-payload';
import { useAuthStore } from '../store/authStore';
import { useSettingsStore } from '../store/settingsStore';
import { usePersistentSessionHost } from './PersistentSessionContext';

export function PersistentSessionStartup({ ready, sessionIntent, onOpen }: {
  ready: boolean; sessionIntent: boolean; onOpen(): void;
}) {
  const host = usePersistentSessionHost();
  const evaluated = useRef(false);
  useEffect(() => {
    if (!ready || evaluated.current) return;
    evaluated.current = true;
    const state = useSettingsStore.getState();
    const email = decodeAuthJwt(useAuthStore.getState().jwt)?.email;
    const preference = state.getPersistentSessionDevicePreference(state.serverUrl, email);
    void host.initialize(onOpen, preference.openOnStart && !sessionIntent);
  }, [ready, sessionIntent, onOpen, host]);
  return null;
}
