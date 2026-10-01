import { act, renderHook } from '@testing-library/react-native';
import { useNodeConnectivityStream } from '../useNodeConnectivityStream';
import { useNodeConnectivityStore } from '../../store/nodeConnectivityStore';
import { useSettingsStore } from '../../store/settingsStore';
import { useAuthStore } from '../../store/authStore';
import { captureAuthScope, resetAuthScopeForTest } from '../../lib/auth-scope';

declare global {
  // eslint-disable-next-line no-var
  var __lastSSEInstance: any;
}

beforeEach(() => {
  jest.useRealTimers();
  useAuthStore.setState({ jwt: null });
  useSettingsStore.setState({ serverUrl: 'https://server.test' });
  resetAuthScopeForTest();
  useNodeConnectivityStore.getState().reset();
});

test('snapshot만 ready를 열고 connected/updated/disconnected를 live 반영한다', () => {
  const { unmount } = renderHook(() => useNodeConnectivityStream());
  const sse = globalThis.__lastSSEInstance;

  expect(sse.url).toBe('https://server.test/api/nodes/stream');
  expect(useNodeConnectivityStore.getState().ready).toBe(false);
  sse.triggerOpen();
  expect(useNodeConnectivityStore.getState().ready).toBe(false);

  act(() => sse.triggerEvent('snapshot', { malformed: true }));
  expect(useNodeConnectivityStore.getState().ready).toBe(false);
  act(() => sse.triggerEvent('node_connected', { nodeId: 'too-early' }));
  expect(useNodeConnectivityStore.getState().connectedNodeIds.size).toBe(0);

  act(() => sse.triggerEvent('snapshot', [
    { nodeId: 'node-a' },
    { nodeId: '  node-b  ' },
    { nodeId: '   ' },
    {},
  ]));
  expect(useNodeConnectivityStore.getState()).toMatchObject({ ready: true });
  expect([...useNodeConnectivityStore.getState().connectedNodeIds]).toEqual(['node-a', 'node-b']);

  act(() => sse.triggerEvent('node_connected', { nodeId: 'node-c' }));
  act(() => sse.triggerEvent('node_updated', { nodeId: 'node-d' }));
  expect([...useNodeConnectivityStore.getState().connectedNodeIds]).toEqual([
    'node-a', 'node-b', 'node-c', 'node-d',
  ]);

  act(() => sse.triggerEvent('node_disconnected', { nodeId: 'node-b' }));
  expect(useNodeConnectivityStore.getState().connectedNodeIds.has('node-b')).toBe(false);
  unmount();
});

test('error와 reconnect open은 not-ready이고 다음 snapshot에서만 복구한다', () => {
  jest.useFakeTimers();
  const { unmount } = renderHook(() => useNodeConnectivityStream());
  const first = globalThis.__lastSSEInstance;
  act(() => first.triggerEvent('snapshot', [{ nodeId: 'node-a' }]));
  expect(useNodeConnectivityStore.getState().ready).toBe(true);

  act(() => first.triggerError({ xhrStatus: 500 }));
  expect(useNodeConnectivityStore.getState().ready).toBe(false);
  act(() => jest.runOnlyPendingTimers());
  const second = globalThis.__lastSSEInstance;
  second.triggerOpen();
  expect(useNodeConnectivityStore.getState().ready).toBe(false);

  act(() => second.triggerEvent('snapshot', [{ nodeId: 'node-a' }]));
  expect(useNodeConnectivityStore.getState().ready).toBe(true);
  unmount();
  jest.useRealTimers();
});

test('auth scope가 바뀌면 이전 connected set을 즉시 폐기한다', () => {
  useNodeConnectivityStore.getState().applySnapshot([{ nodeId: 'node-a' }]);
  const previousGeneration = captureAuthScope().generation;

  useAuthStore.setState({ jwt: 'next-user' });

  const state = useNodeConnectivityStore.getState();
  expect(state.scopeGeneration).not.toBe(previousGeneration);
  expect(state.scopeGeneration).toBe(captureAuthScope().generation);
  expect(state.ready).toBe(false);
  expect(state.connectedNodeIds.size).toBe(0);
});

test('background→active reconnect 시작 즉시 open 전에도 not-ready가 된다', () => {
  (globalThis as any).__appStateListeners = [];
  const AppStateMock = require('react-native/Libraries/AppState/AppState').default;
  AppStateMock.currentState = 'active';
  const { unmount } = renderHook(() => useNodeConnectivityStream());
  const first = globalThis.__lastSSEInstance;
  act(() => first.triggerEvent('snapshot', [{ nodeId: 'node-a' }]));
  expect(useNodeConnectivityStore.getState().ready).toBe(true);

  act(() => {
    for (const listener of (globalThis as any).__appStateListeners) listener('background');
    for (const listener of (globalThis as any).__appStateListeners) listener('active');
  });

  const second = globalThis.__lastSSEInstance;
  expect(second).not.toBe(first);
  expect(second.closed).toBe(false);
  expect(useNodeConnectivityStore.getState().ready).toBe(false);
  act(() => second.triggerEvent('snapshot', [{ nodeId: 'node-a' }]));
  expect(useNodeConnectivityStore.getState().ready).toBe(true);
  unmount();
});
