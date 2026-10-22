import { useCallback, useState, useSyncExternalStore, type SetStateAction } from 'react';
import { useAuthScopeGeneration } from '../lib/auth-scope';
import { decodeAuthJwt } from '../auth/jwt-payload';
import { useAuthStore } from '../store/authStore';
import { useSettingsStore } from '../store/settingsStore';
import { useDraftStore } from '../store/draftStore';
import { useOptionalLayoutContinuity } from '../navigation/LayoutContinuityContext';

function subscribeHydration(listener: () => void) {
  const stores = [useDraftStore, useAuthStore, useSettingsStore];
  const unsubscribes = stores.flatMap(store => [store.persist.onHydrate(listener), store.persist.onFinishHydration(listener)]);
  return () => unsubscribes.forEach(unsubscribe => unsubscribe());
}
const hasHydrated = () => useDraftStore.persist.hasHydrated()
  && useAuthStore.persist.hasHydrated() && useSettingsStore.persist.hasHydrated();

/** Owns only user edits; changing server/default values never writes a draft. */
export function usePersistentDraft(
  role: string,
  target: readonly (string | null | undefined)[],
  initialValue: string,
) {
  const serverUrl = useSettingsStore(state => state.serverUrl);
  const jwt = useAuthStore(state => state.jwt);
  const hydrated = useSyncExternalStore(subscribeHydration, hasHydrated, hasHydrated);
  const userId = decodeAuthJwt(jwt)?.email;
  const key = serverUrl && userId ? JSON.stringify([serverUrl, userId, role, target]) : null;
  const generation = useAuthScopeGeneration();
  const localKey = JSON.stringify([generation, role, target]);
  const continuity = useOptionalLayoutContinuity();
  const memoryTarget = JSON.stringify(target);
  const memoryDraft = key === null && continuity
    ? continuity.getMemoryDraft(generation, role, memoryTarget)
    : undefined;
  const [, setMemoryEpoch] = useState(0);
  const bumpMemory = useCallback(() => setMemoryEpoch(epoch => epoch + 1), []);
  const [local, setLocal] = useState<{ key: string | null; value: string } | null>(null);
  const saved = useDraftStore(state => key && hydrated ? state.drafts[key] : undefined);
  const ready = hydrated;
  const localValue = local?.key === localKey ? local.value : undefined;
  const value = saved === undefined
    ? key === null
      ? localValue ?? memoryDraft ?? initialValue
      : initialValue
    : saved;
  const setValue = useCallback((update: SetStateAction<string>) => {
    if (!ready) return;
    if (!key) {
      const current = localValue ?? memoryDraft ?? initialValue;
      const next = typeof update === 'function' ? (update as (previous: string) => string)(current) : update;
      if (continuity) {
        continuity.setMemoryDraft(generation, role, memoryTarget, next);
        bumpMemory();
      }
      setLocal({ key: localKey, value: next });
      return;
    }
    const current = useDraftStore.getState().drafts[key];
    const next = typeof update === 'function' ? (update as (previous: string) => string)(current ?? initialValue) : update;
    if (next === initialValue) useDraftStore.getState().remove(key);
    else useDraftStore.getState().write(key, next);
  }, [key, localKey, ready, initialValue, continuity, generation, role, memoryTarget, localValue, memoryDraft, bumpMemory]);
  const clear = useCallback(() => {
    if (key) useDraftStore.getState().remove(key);
    else {
      const current = memoryDraft ?? localValue;
      if (current !== undefined) continuity?.clearMemoryDraftIfMatches(generation, role, memoryTarget, current);
      setLocal(null);
      bumpMemory();
    }
  }, [key, continuity, generation, role, memoryTarget, localValue, memoryDraft, bumpMemory]);
  const clearIfMatches = useCallback((submitted: string) => {
    if (key) useDraftStore.getState().remove(key, submitted);
    else {
      continuity?.clearMemoryDraftIfMatches(generation, role, memoryTarget, submitted);
      setLocal(previous => previous?.key === localKey && previous.value === submitted ? null : previous);
      if (continuity) bumpMemory();
    }
  }, [key, localKey, continuity, generation, role, memoryTarget, bumpMemory]);
  return {
    value,
    setValue,
    clear,
    clearIfMatches,
    ready,
    hasDraft: saved !== undefined || (key === null && (
      continuity
        ? memoryDraft !== undefined ? memoryDraft !== initialValue : localValue !== undefined
        : localValue !== undefined
    )),
    key,
  };
}
