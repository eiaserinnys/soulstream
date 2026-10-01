import { useMemo } from 'react';
import { createApiClient } from '../api/client';
import {
  captureAuthScope,
  isAuthScopeCurrent,
  useAuthScopeGeneration,
} from '../lib/auth-scope';
import { useSettingsStore } from '../store/settingsStore';
import { useNodeConnectivityStore } from '../store/nodeConnectivityStore';
import { NODE_STREAM_EVENTS, useSSEStream } from './useSSEStream';

export function useNodeConnectivityStream(): void {
  const serverUrl = useSettingsStore((state) => state.serverUrl);
  const scopeGeneration = useAuthScopeGeneration();
  const scope = useMemo(() => captureAuthScope(), [scopeGeneration]);
  const api = useMemo(
    () => (serverUrl ? createApiClient(serverUrl, { authScope: scope }) : null),
    [scope, serverUrl],
  );

  const storeForCurrentScope = () => {
    if (!isAuthScopeCurrent(scope)) return null;
    const store = useNodeConnectivityStore.getState();
    return store.scopeGeneration === scope.generation ? store : null;
  };

  useSSEStream({
    diagnosticsSource: 'node_stream',
    urlBuilder: () => api?.nodeStreamUrl() ?? '',
    eventTypes: [...NODE_STREAM_EVENTS],
    enabled: api !== null,
    scopeGeneration: scope.generation,
    connectionKey: `${scope.generation}:${serverUrl ?? ''}`,
    onConnecting: () => storeForCurrentScope()?.markNotReady(),
    onError: () => storeForCurrentScope()?.markNotReady(),
    onEvent: (type, data) => {
      const store = storeForCurrentScope();
      if (!store) return;
      switch (type) {
        case 'snapshot':
          store.applySnapshot(data);
          break;
        case 'node_connected':
        case 'node_updated':
          store.upsert(data);
          break;
        case 'node_disconnected':
          store.remove(data);
          break;
      }
    },
  });
}
