import { useCallback, useState, useSyncExternalStore, type SetStateAction } from 'react';
import { decodeAuthJwt } from '../auth/jwt-payload';
import { useAuthStore } from '../store/authStore';
import { useSettingsStore } from '../store/settingsStore';
import { useDraftStore, type DraftValue } from '../store/draftStore';

function subscribeHydration(listener: () => void) {
  const stores = [useDraftStore, useAuthStore, useSettingsStore];
  const unsubscribes = stores.flatMap(store => [store.persist.onHydrate(listener), store.persist.onFinishHydration(listener)]);
  return () => unsubscribes.forEach(unsubscribe => unsubscribe());
}
const hasHydrated = () => useDraftStore.persist.hasHydrated()
  && useAuthStore.persist.hasHydrated() && useSettingsStore.persist.hasHydrated();

/** Owns only user edits; changing server/default values never writes a draft. */
export function usePersistentDraft<T>(
  role: string,
  target: readonly (string | null | undefined)[],
  initialValue: T,
  options: { deviceLocal?: boolean } = {},
) {
  const serverUrl = useSettingsStore(state => state.serverUrl);
  const jwt = useAuthStore(state => state.jwt);
  const hydrated = useSyncExternalStore(subscribeHydration, hasHydrated, hasHydrated);
  const userId = decodeAuthJwt(jwt)?.email;
  const key = options.deviceLocal && role === 'connection-settings'
    ? JSON.stringify(['device', role])
    : serverUrl && userId ? JSON.stringify([serverUrl, userId, role, target]) : null;
  const [local, setLocal] = useState<{ key: string | null; value: T } | null>(null);
  const saved = useDraftStore(state => key && hydrated ? state.drafts[key] : undefined);
  const ready = hydrated;
  const value = saved === undefined
    ? key === null && local?.key === key ? local.value : initialValue
    : saved as T;
  const setValue = useCallback((update: SetStateAction<T>) => {
    if (!ready) return;
    if (!key) {
      setLocal(previous => ({ key, value: typeof update === 'function'
        ? (update as (previous: T) => T)(previous?.key === key ? previous.value : initialValue) : update }));
      return;
    }
    const current = useDraftStore.getState().drafts[key] as T | undefined;
    const next = typeof update === 'function' ? (update as (previous: T) => T)(current ?? initialValue) : update;
    if (JSON.stringify(next) === JSON.stringify(initialValue)) useDraftStore.getState().remove(key);
    else useDraftStore.getState().write(key, next as DraftValue);
  }, [key, ready, initialValue]);
  const clear = useCallback(() => {
    if (key) useDraftStore.getState().remove(key);
    else setLocal(null);
  }, [key]);
  const clearIfMatches = useCallback((submitted: T) => {
    if (key) useDraftStore.getState().remove(key, submitted as DraftValue);
    else setLocal(previous => previous && JSON.stringify(previous.value) === JSON.stringify(submitted) ? null : previous);
  }, [key]);
  return { value, setValue, clear, clearIfMatches, ready, hasDraft: saved !== undefined || (key === null && local?.key === key), key };
}
