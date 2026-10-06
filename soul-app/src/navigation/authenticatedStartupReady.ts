import { useSyncExternalStore } from 'react';
import { useAuthStore } from '../store/authStore';
import { useSettingsStore } from '../store/settingsStore';
import { navigationRef } from './navigationRef';

const stores = [useAuthStore, useSettingsStore];
function subscribeHydration(listener: () => void) {
  const subscriptions = stores.flatMap(store => [store.persist.onHydrate(listener), store.persist.onFinishHydration(listener)]);
  return () => subscriptions.forEach(remove => remove());
}
const hydrated = () => stores.every(store => store.persist.hasHydrated());
function subscribeNavigation(listener: () => void) {
  const ready = navigationRef.addListener('ready', listener);
  const state = navigationRef.addListener('state', listener);
  return () => { ready(); state(); };
}
const navigationReady = () => navigationRef.isReady();
export function useAuthenticatedStartupReady() {
  return {
    hydrated: useSyncExternalStore(subscribeHydration, hydrated, hydrated),
    navigationReady: useSyncExternalStore(subscribeNavigation, navigationReady, navigationReady),
  };
}
