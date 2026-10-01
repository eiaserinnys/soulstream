import { useSyncExternalStore } from 'react';
import { useAuthStore } from '../store/authStore';
import { useSettingsStore } from '../store/settingsStore';

export interface AuthScopeSnapshot {
  readonly serverUrl: string;
  readonly jwt: string | null;
  readonly generation: string;
}

type ScopeListener = (
  current: AuthScopeSnapshot,
  previous: AuthScopeSnapshot | null,
) => void;

let serial = 0;
let observedServerUrl: string | undefined;
let observedJwt: string | null | undefined;
let currentScope: AuthScopeSnapshot | null = null;
const listeners = new Set<ScopeListener>();

function nextGeneration(): string {
  serial += 1;
  return `auth-scope-${serial}`;
}

function observeAuthScope(): AuthScopeSnapshot {
  const serverUrl = useSettingsStore.getState().serverUrl;
  const jwt = useAuthStore.getState().jwt;
  if (
    currentScope
    && observedServerUrl === serverUrl
    && observedJwt === jwt
  ) return currentScope;

  const previous = currentScope;
  observedServerUrl = serverUrl;
  observedJwt = jwt;
  currentScope = Object.freeze({
    serverUrl,
    jwt,
    generation: nextGeneration(),
  });
  for (const listener of listeners) listener(currentScope, previous);
  return currentScope;
}

useAuthStore.subscribe(() => { observeAuthScope(); });
useSettingsStore.subscribe(() => { observeAuthScope(); });

export function captureAuthScope(): AuthScopeSnapshot {
  return observeAuthScope();
}

export function isAuthScopeCurrent(scope: Pick<AuthScopeSnapshot, 'serverUrl' | 'generation'>): boolean {
  const current = observeAuthScope();
  return current.serverUrl === scope.serverUrl && current.generation === scope.generation;
}

export function clearAuthForScope(
  scope: Pick<AuthScopeSnapshot, 'serverUrl' | 'generation'>,
): boolean {
  if (!isAuthScopeCurrent(scope)) return false;
  useAuthStore.getState().rejectAuth();
  return true;
}

export function subscribeAuthScope(listener: ScopeListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useAuthScopeGeneration(): string {
  return useSyncExternalStore(
    (notify) => subscribeAuthScope(() => notify()),
    () => captureAuthScope().generation,
    () => captureAuthScope().generation,
  );
}

export function resetAuthScopeForTest(): void {
  observedServerUrl = undefined;
  observedJwt = undefined;
  currentScope = null;
  observeAuthScope();
}
