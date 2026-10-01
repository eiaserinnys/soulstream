import { renderHook } from '@testing-library/react-native';
import { SESSION_EVENT_TYPES, useSSEStream } from '../useSSEStream';
import {
  bindSessionDiagnosticsSink,
  type SessionDiagnosticsSink,
} from '../../lib/session-diagnostics-api';

let mockScopeGeneration = 'scope-a';
const mockClearAuthForScope = jest.fn();
jest.mock('../../lib/auth-scope', () => ({
  captureAuthScope: () => ({
    serverUrl: 'https://example.test',
    jwt: null,
    generation: mockScopeGeneration,
  }),
  isAuthScopeCurrent: (scope: { generation: string }) =>
    scope.generation === mockScopeGeneration,
  clearAuthForScope: (...args: unknown[]) => mockClearAuthForScope(...args),
  useAuthScopeGeneration: () => mockScopeGeneration,
}));

declare global {
  // jest.setup.js의 react-native-sse mock이 노출하는 인스턴스.
  // eslint-disable-next-line no-var
  var __lastSSEInstance: any;
}

beforeEach(() => {
  mockScopeGeneration = 'scope-a';
  mockClearAuthForScope.mockClear();
});

function exhaustRetryBudget() {
  for (let retry = 0; retry < 20; retry += 1) {
    globalThis.__lastSSEInstance.triggerError({ xhrStatus: 500 });
    jest.runOnlyPendingTimers();
  }
  const exhausted = globalThis.__lastSSEInstance;
  exhausted.triggerError({ xhrStatus: 500 });
  return exhausted;
}

test('session named event 목록은 catchup marker와 text snapshot을 정확히 한 번 구독한다', () => {
  expect(SESSION_EVENT_TYPES.filter((type) => type === 'turn_summary')).toHaveLength(1);
  expect(SESSION_EVENT_TYPES.filter((type) => type === 'session_ended')).toHaveLength(1);
  expect(SESSION_EVENT_TYPES.filter((type) => type === 'text_snapshot')).toHaveLength(1);
});

test('turn_summary named event payload를 onEvent로 전달한다', () => {
  const onEvent = jest.fn();
  const payload = {
    content: '직전 턴 요약',
    final_response_event_id: 42,
  };
  renderHook(() =>
    useSSEStream({
      urlBuilder: () => 'https://example.test/stream',
      eventTypes: SESSION_EVENT_TYPES,
      onEvent,
      enabled: true,
    }),
  );

  globalThis.__lastSSEInstance.triggerEvent('turn_summary', payload);

  expect(onEvent).toHaveBeenCalledWith('turn_summary', payload, '');
});

test('session_ended named event payload와 event id를 onEvent로 전달한다', () => {
  const onEvent = jest.fn();
  const payload = {
    status: 'completed',
    termination_reason: 'completed_ok',
    termination_detail: null,
    _event_id: 42,
  };
  renderHook(() =>
    useSSEStream({
      urlBuilder: () => 'https://example.test/stream',
      eventTypes: SESSION_EVENT_TYPES,
      onEvent,
      enabled: true,
    }),
  );

  globalThis.__lastSSEInstance.triggerEvent('session_ended', payload, '42');

  expect(onEvent).toHaveBeenCalledWith('session_ended', payload, '42');
});

describe('useSSEStream onOpen', () => {
  test('diagnostics record fixed-source open, transport error, and close counts', () => {
    const connections: unknown[][] = [];
    bindSessionDiagnosticsSink({
      recordRoute: jest.fn(),
      recordModal: jest.fn(),
      recordSseConnection: (...args) => connections.push(args),
      recordSseMessage: jest.fn(),
      recordStoreUpdate: jest.fn(),
      recordFeedRender: jest.fn(),
      beginOperation: () => ({ id: 1, startedAtMs: 1, startedAtMonotonicMs: 1 }),
      endOperation: jest.fn(),
    } as SessionDiagnosticsSink);

    try {
      const { unmount } = renderHook(() =>
        useSSEStream({
          urlBuilder: () => 'https://example.test/stream',
          eventTypes: ['message'],
          onEvent: jest.fn(),
          diagnosticsSource: 'feed_stream',
          enabled: true,
        }),
      );
      globalThis.__lastSSEInstance.triggerOpen();
      globalThis.__lastSSEInstance.triggerError({ xhrStatus: 500 });
      unmount();
    } finally {
      bindSessionDiagnosticsSink(null);
    }

    expect(connections).toEqual([
      ['feed_stream', 'open'],
      ['feed_stream', 'error'],
      ['feed_stream', 'close'],
    ]);
  });

  test('consumer commit throw는 연결을 닫고 마지막 committed cursor로 재연결한다', () => {
    jest.useFakeTimers();
    let committedCursor = '40';
    const commitError = new Error('store commit failed');
    const onEvent = jest.fn((_type: string, _data: unknown, eid: string) => {
      if (eid === '41') throw commitError;
      committedCursor = eid;
    });
    const onError = jest.fn();
    const urlBuilder = jest.fn(() =>
      `https://example.test/stream?lastEventId=${committedCursor}`,
    );
    renderHook(() =>
      useSSEStream({
        urlBuilder,
        eventTypes: ['message'],
        onEvent,
        onError,
        enabled: true,
      }),
    );

    const first = globalThis.__lastSSEInstance;
    first.triggerEvent('message', { value: 'failed' }, '41');
    first.triggerEvent('message', { value: 'must-not-skip' }, '42');

    expect(first.closed).toBe(true);
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(commitError);
    expect(committedCursor).toBe('40');

    jest.runOnlyPendingTimers();
    expect(globalThis.__lastSSEInstance.url).toBe(
      'https://example.test/stream?lastEventId=40',
    );
    jest.useRealTimers();
  });

  test('비동기 consumer failure bridge도 현재 연결을 즉시 닫고 재연결한다', () => {
    jest.useFakeTimers();
    const consumerFailureRef = { current: jest.fn((_error: unknown) => undefined) };
    const onError = jest.fn();
    renderHook(() =>
      useSSEStream({
        urlBuilder: () => 'https://example.test/stream?lastEventId=50',
        eventTypes: ['message'],
        onEvent: jest.fn(),
        onError,
        consumerFailureRef,
        enabled: true,
      }),
    );

    const first = globalThis.__lastSSEInstance;
    const error = new Error('async store commit failed');
    consumerFailureRef.current(error);

    expect(first.closed).toBe(true);
    expect(onError).toHaveBeenCalledWith(error);
    jest.runOnlyPendingTimers();
    expect(globalThis.__lastSSEInstance).not.toBe(first);
    jest.useRealTimers();
  });

  test('첫 연결과 재연결 EventSource 생성 직전에 onConnecting을 호출한다', () => {
    jest.useFakeTimers();
    const onConnecting = jest.fn();
    renderHook(() =>
      useSSEStream({
        urlBuilder: () => 'https://example.test/stream',
        eventTypes: ['message'],
        onEvent: jest.fn(),
        onConnecting,
        enabled: true,
      }),
    );

    const first = globalThis.__lastSSEInstance;
    expect(onConnecting).toHaveBeenCalledTimes(1);
    first.triggerError({ xhrStatus: 500 });
    jest.runOnlyPendingTimers();

    expect(globalThis.__lastSSEInstance).not.toBe(first);
    expect(onConnecting).toHaveBeenCalledTimes(2);
    jest.useRealTimers();
  });

  test('SSE open 이벤트 발생 시 onOpen 콜백이 호출된다', () => {
    const onOpen = jest.fn();
    const onEvent = jest.fn();

    renderHook(() =>
      useSSEStream({
        urlBuilder: () => 'https://example.test/stream',
        eventTypes: ['message'],
        onOpen,
        onEvent,
        enabled: true,
      }),
    );

    const sse = globalThis.__lastSSEInstance;
    expect(sse).toBeDefined();
    expect(onOpen).not.toHaveBeenCalled();

    sse.triggerOpen();
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  test('react-native-sse 자동 polling은 끄고 useSSEStream retry만 사용한다', () => {
    renderHook(() =>
      useSSEStream({
        urlBuilder: () => 'https://example.test/stream',
        eventTypes: ['message'],
        onEvent: jest.fn(),
        enabled: true,
      }),
    );

    expect(globalThis.__lastSSEInstance.options.pollingInterval).toBe(0);
  });

  test('onOpen이 미제공이어도 기존 동작에 영향이 없다 (회귀 방지)', () => {
    const onEvent = jest.fn();

    expect(() => {
      renderHook(() =>
        useSSEStream({
          urlBuilder: () => 'https://example.test/stream',
          eventTypes: ['message'],
          onEvent,
          enabled: true,
        }),
      );
      const sse = globalThis.__lastSSEInstance;
      sse.triggerOpen();
      sse.triggerEvent('message', { hello: 'world' });
    }).not.toThrow();
    expect(onEvent).toHaveBeenCalledWith('message', { hello: 'world' }, '');
  });

  test('재연결(error → 새 EventSource) 시에도 onOpen이 다시 호출된다', () => {
    jest.useFakeTimers();
    const onOpen = jest.fn();
    const onEvent = jest.fn();
    const onError = jest.fn();

    renderHook(() =>
      useSSEStream({
        urlBuilder: () => 'https://example.test/stream',
        eventTypes: ['message'],
        onOpen,
        onEvent,
        onError,
        enabled: true,
      }),
    );

    const first = globalThis.__lastSSEInstance;
    first.triggerOpen();
    expect(onOpen).toHaveBeenCalledTimes(1);

    // 에러 발생 → 재연결 타이머 예약 (status는 401 외 임의 값으로)
    first.triggerError({ xhrStatus: 500 });
    expect(onError).toHaveBeenCalledTimes(1);

    // 재연결 타이머 진행 — 새 EventSource 인스턴스가 생성되어 __lastSSEInstance 갱신
    jest.runOnlyPendingTimers();
    const second = globalThis.__lastSSEInstance;
    expect(second).not.toBe(first);

    second.triggerOpen();
    expect(onOpen).toHaveBeenCalledTimes(2);

    jest.useRealTimers();
  });
});

describe('useSSEStream urlBuilder', () => {
  test('첫 connect 시 urlBuilder()를 호출하여 EventSource URL을 만든다', () => {
    const urlBuilder = jest.fn(() => 'https://example.test/stream?lastEventId=42');

    renderHook(() =>
      useSSEStream({
        urlBuilder,
        eventTypes: ['message'],
        onEvent: jest.fn(),
        enabled: true,
      }),
    );

    expect(urlBuilder).toHaveBeenCalledTimes(1);
    expect(globalThis.__lastSSEInstance.url).toBe(
      'https://example.test/stream?lastEventId=42',
    );
  });

  test('빈 URL을 반환하면 connect를 건너뛴다', () => {
    delete globalThis.__lastSSEInstance;
    const urlBuilder = jest.fn(() => '');

    renderHook(() =>
      useSSEStream({
        urlBuilder,
        eventTypes: ['message'],
        onEvent: jest.fn(),
        enabled: true,
      }),
    );

    expect(urlBuilder).toHaveBeenCalledTimes(1);
    expect(globalThis.__lastSSEInstance).toBeUndefined();
  });

  test('재연결 시 urlBuilder가 다시 호출되어 최신 URL이 부착된다', () => {
    jest.useFakeTimers();
    let lastEventId = '';
    const urlBuilder = jest.fn(() =>
      lastEventId
        ? `https://example.test/stream?lastEventId=${lastEventId}`
        : 'https://example.test/stream',
    );

    renderHook(() =>
      useSSEStream({
        urlBuilder,
        eventTypes: ['message'],
        onEvent: jest.fn(),
        onError: jest.fn(),
        enabled: true,
      }),
    );

    const first = globalThis.__lastSSEInstance;
    expect(first.url).toBe('https://example.test/stream');

    // 외부 상태(여기서는 클로저 변수)가 갱신된 상태에서 재연결을 유도.
    lastEventId = '99';
    first.triggerError({ xhrStatus: 500 });
    jest.runOnlyPendingTimers();

    const second = globalThis.__lastSSEInstance;
    expect(second).not.toBe(first);
    expect(second.url).toBe('https://example.test/stream?lastEventId=99');
    expect(urlBuilder).toHaveBeenCalledTimes(2);

    jest.useRealTimers();
  });

  test('connectionKey가 변경되면 새 SSE 사이클을 생성한다', () => {
    const urlBuilder = jest.fn(() => 'https://example.test/stream');

    const { rerender } = renderHook<void, { key: string }>(
      ({ key }: { key: string }) =>
        useSSEStream({
          urlBuilder,
          eventTypes: ['message'],
          onEvent: jest.fn(),
          enabled: true,
          connectionKey: key,
        }),
      { initialProps: { key: 'session-A' } },
    );

    const first = globalThis.__lastSSEInstance;
    expect(first).toBeDefined();
    expect(first.closed).toBe(false);

    rerender({ key: 'session-B' });

    // cleanup → close + 새 connect
    expect(first.closed).toBe(true);
    const second = globalThis.__lastSSEInstance;
    expect(second).not.toBe(first);
    expect(urlBuilder).toHaveBeenCalledTimes(2);
  });

  test('20회 재시도 예산 소진 뒤 명시 connectionKey 재시도는 새 연결을 한 번만 연다', () => {
    jest.useFakeTimers();
    const urlBuilder = jest.fn(() => 'https://example.test/stream');
    const { rerender } = renderHook<void, { key: string }>(
      ({ key }) => useSSEStream({
        urlBuilder,
        eventTypes: ['message'],
        onEvent: jest.fn(),
        enabled: true,
        connectionKey: key,
      }),
      { initialProps: { key: 'catalog-retry:0' } },
    );

    const exhausted = exhaustRetryBudget();
    expect(exhausted.closed).toBe(true);
    expect(urlBuilder).toHaveBeenCalledTimes(21);

    rerender({ key: 'catalog-retry:1' });

    expect(globalThis.__lastSSEInstance).not.toBe(exhausted);
    expect(urlBuilder).toHaveBeenCalledTimes(22);
    rerender({ key: 'catalog-retry:1' });
    expect(urlBuilder).toHaveBeenCalledTimes(22);
    jest.useRealTimers();
  });

  test('cleanup된 이전 EventSource의 stale listener는 최신 onEvent를 호출하지 않는다', () => {
    const firstOnEvent = jest.fn();
    const secondOnEvent = jest.fn();

    const { rerender } = renderHook<void, { key: string; onEvent: jest.Mock }>(
      ({ key, onEvent }: { key: string; onEvent: jest.Mock }) =>
        useSSEStream({
          urlBuilder: () => `https://example.test/stream/${key}`,
          eventTypes: ['message'],
          onEvent,
          enabled: true,
          connectionKey: key,
        }),
      { initialProps: { key: 'session-A', onEvent: firstOnEvent } },
    );

    const first = globalThis.__lastSSEInstance;
    rerender({ key: 'session-B', onEvent: secondOnEvent });

    first.triggerEvent('message', { leaked: true }, '10');

    expect(firstOnEvent).not.toHaveBeenCalled();
    expect(secondOnEvent).not.toHaveBeenCalled();
  });

  test('connectionKey가 동일하면 재연결되지 않는다 (lastEventId-only 변화 회귀)', () => {
    let lastEventId = '';
    const urlBuilder = jest.fn(() =>
      lastEventId
        ? `https://example.test/stream?lastEventId=${lastEventId}`
        : 'https://example.test/stream',
    );

    const { rerender } = renderHook<void, { tick: number }>(
      ({ tick }: { tick: number }) =>
        useSSEStream({
          urlBuilder,
          eventTypes: ['message'],
          onEvent: jest.fn(),
          enabled: true,
          connectionKey: 'session-A',
          // tick은 컴포넌트 렌더 카운트만 증가시키는 더미 prop.
        }),
      { initialProps: { tick: 0 } },
    );

    const first = globalThis.__lastSSEInstance;
    expect(urlBuilder).toHaveBeenCalledTimes(1);

    // 외부 상태(lastEventId) 변화는 SSE를 재연결시키지 않아야 한다.
    lastEventId = '50';
    rerender({ tick: 1 });
    rerender({ tick: 2 });

    expect(globalThis.__lastSSEInstance).toBe(first);
    expect(urlBuilder).toHaveBeenCalledTimes(1); // re-render에도 추가 호출 없음
    expect(first.closed).toBe(false);
  });
});

describe('useSSEStream AppState 게이트', () => {
  function fireAppState(state: 'active' | 'background' | 'inactive') {
    const listeners = (globalThis as any).__appStateListeners ?? [];
    for (const fn of listeners) fn(state);
  }

  beforeEach(() => {
    (globalThis as any).__appStateListeners = [];
    delete globalThis.__lastSSEInstance;
    const AppStateMock = require('react-native/Libraries/AppState/AppState').default;
    AppStateMock.currentState = 'active';
  });

  test('background 진입 즉시 연결을 닫고 active 복귀 시 한 번만 reconnect한다', () => {
    renderHook(() =>
      useSSEStream({
        urlBuilder: () => 'https://example.test/stream',
        eventTypes: ['message'],
        onEvent: jest.fn(),
        enabled: true,
      }),
    );

    const first = globalThis.__lastSSEInstance;
    expect(first).toBeDefined();
    expect(first.closed).toBe(false);

    fireAppState('background');
    expect(first.closed).toBe(true);
    expect(globalThis.__lastSSEInstance).toBe(first);
    fireAppState('active');

    expect(first.closed).toBe(true);
    const second = globalThis.__lastSSEInstance;
    expect(second).not.toBe(first);
    expect(second.closed).toBe(false);
  });

  test('20회 재시도 예산 소진 뒤 background → active 복귀는 새 연결을 한 번만 연다', () => {
    jest.useFakeTimers();
    const urlBuilder = jest.fn(() => 'https://example.test/stream');
    renderHook(() =>
      useSSEStream({
        urlBuilder,
        eventTypes: ['message'],
        onEvent: jest.fn(),
        enabled: true,
      }),
    );

    const exhausted = exhaustRetryBudget();
    expect(urlBuilder).toHaveBeenCalledTimes(21);

    fireAppState('background');
    fireAppState('active');

    expect(globalThis.__lastSSEInstance).not.toBe(exhausted);
    expect(urlBuilder).toHaveBeenCalledTimes(22);
    fireAppState('active');
    expect(urlBuilder).toHaveBeenCalledTimes(22);
    jest.useRealTimers();
  });

  test('enabled=false 전환은 현재 연결을 닫고 다시 true가 될 때 한 번만 연결한다', () => {
    const { rerender } = renderHook<void, { enabled: boolean }>(
      ({ enabled }) =>
        useSSEStream({
          urlBuilder: () => 'https://example.test/stream',
          eventTypes: ['message'],
          onEvent: jest.fn(),
          enabled,
        }),
      { initialProps: { enabled: true } },
    );
    const first = globalThis.__lastSSEInstance;

    rerender({ enabled: false });
    expect(first.closed).toBe(true);
    expect(globalThis.__lastSSEInstance).toBe(first);

    rerender({ enabled: true });
    const second = globalThis.__lastSSEInstance;
    expect(second).not.toBe(first);
    expect(second.closed).toBe(false);
  });

  test('background suspend callback은 close 전에 한 번 호출되고 inactive만으로는 호출되지 않는다', () => {
    const order: string[] = [];
    const onSuspending = jest.fn(() => order.push('suspend'));
    renderHook(() =>
      useSSEStream({
        urlBuilder: () => 'https://example.test/stream',
        eventTypes: ['message'],
        onEvent: jest.fn(),
        onSuspending,
        enabled: true,
      }),
    );
    const first = globalThis.__lastSSEInstance;
    const originalClose = first.close.bind(first);
    first.close = jest.fn(() => {
      order.push('close');
      originalClose();
    });

    fireAppState('inactive');
    fireAppState('active');
    expect(onSuspending).not.toHaveBeenCalled();
    expect(first.closed).toBe(false);

    fireAppState('background');
    expect(onSuspending).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['suspend', 'close']);
  });

  test('iOS 표준 복귀 경로 background → inactive → active도 reconnect한다', () => {
    renderHook(() =>
      useSSEStream({
        urlBuilder: () => 'https://example.test/stream',
        eventTypes: ['message'],
        onEvent: jest.fn(),
        enabled: true,
      }),
    );

    const first = globalThis.__lastSSEInstance;

    fireAppState('background'); // wasBackgrounded = true
    fireAppState('inactive'); // 통과 (플래그 보존)
    fireAppState('active'); // 트리거 O

    expect(first.closed).toBe(true);
    const second = globalThis.__lastSSEInstance;
    expect(second).not.toBe(first);
  });

  test('active → inactive → background → active 시퀀스도 reconnect한다', () => {
    // background 진입 전 잠깐 inactive를 거치는 iOS 패턴.
    // 명세 본문의 게이트 설계 결정에 명시된 시나리오 — 회귀 보호.
    renderHook(() =>
      useSSEStream({
        urlBuilder: () => 'https://example.test/stream',
        eventTypes: ['message'],
        onEvent: jest.fn(),
        enabled: true,
      }),
    );

    const first = globalThis.__lastSSEInstance;

    fireAppState('inactive'); // wasBackgrounded는 false (통과)
    fireAppState('background'); // wasBackgrounded = true
    fireAppState('active'); // 트리거 O

    expect(first.closed).toBe(true);
    const second = globalThis.__lastSSEInstance;
    expect(second).not.toBe(first);
  });

  test('active → inactive → active 전이는 reconnect를 트리거하지 않는다', () => {
    renderHook(() =>
      useSSEStream({
        urlBuilder: () => 'https://example.test/stream',
        eventTypes: ['message'],
        onEvent: jest.fn(),
        enabled: true,
      }),
    );

    const first = globalThis.__lastSSEInstance;

    fireAppState('inactive'); // wasBackgrounded는 여전히 false
    fireAppState('active'); // 트리거 X

    expect(first.closed).toBe(false);
    expect(globalThis.__lastSSEInstance).toBe(first);
  });

  test('컴포넌트 언마운트 시 AppState 리스너가 제거된다', () => {
    const { unmount } = renderHook(() =>
      useSSEStream({
        urlBuilder: () => 'https://example.test/stream',
        eventTypes: ['message'],
        onEvent: jest.fn(),
        enabled: true,
      }),
    );

    expect((globalThis as any).__appStateListeners.length).toBe(1);
    unmount();
    expect((globalThis as any).__appStateListeners.length).toBe(0);
  });

  test('reconnect 시 urlBuilder가 다시 호출되어 최신 lastEventId가 부착된다', () => {
    let lastEventId = '';
    const urlBuilder = jest.fn(() =>
      lastEventId
        ? `https://example.test/stream?lastEventId=${lastEventId}`
        : 'https://example.test/stream',
    );

    renderHook(() =>
      useSSEStream({
        urlBuilder,
        eventTypes: ['message'],
        onEvent: jest.fn(),
        enabled: true,
      }),
    );

    const first = globalThis.__lastSSEInstance;
    expect(first.url).toBe('https://example.test/stream');

    lastEventId = '123';
    fireAppState('background');
    fireAppState('active');

    const second = globalThis.__lastSSEInstance;
    expect(second).not.toBe(first);
    expect(second.url).toBe('https://example.test/stream?lastEventId=123');
  });
});

describe('useSSEStream auth generation lifecycle', () => {
  test('generation 변경은 old EventSource를 닫고 새 고정 scope 연결을 만든다', () => {
    const onEvent = jest.fn();
    const { rerender } = renderHook<void, { generation: string }>(
      ({ generation }) => useSSEStream({
        urlBuilder: () => 'https://example.test/stream',
        eventTypes: ['message'],
        onEvent,
        enabled: true,
        scopeGeneration: generation,
      }),
      { initialProps: { generation: 'scope-a' } },
    );
    const first = globalThis.__lastSSEInstance;
    const queuedOldEvent = first.listeners.message[0];

    mockScopeGeneration = 'scope-b';
    rerender({ generation: 'scope-b' });
    const second = globalThis.__lastSSEInstance;
    expect(first.closed).toBe(true);
    expect(second).not.toBe(first);

    queuedOldEvent({ type: 'message', data: JSON.stringify({ stale: true }), lastEventId: '1' });
    expect(onEvent).not.toHaveBeenCalled();
    second.triggerEvent('message', { fresh: true }, '2');
    expect(onEvent).toHaveBeenCalledWith('message', { fresh: true }, '2');
  });

  test('old 401과 cleanup 뒤 queued error는 현재 인증을 지우지 않고 current 401만 지운다', () => {
    const { rerender } = renderHook<void, { generation: string }>(
      ({ generation }) => useSSEStream({
        urlBuilder: () => 'https://example.test/stream',
        eventTypes: ['message'],
        onEvent: jest.fn(),
        enabled: true,
        scopeGeneration: generation,
      }),
      { initialProps: { generation: 'scope-a' } },
    );
    const first = globalThis.__lastSSEInstance;
    const queuedOldError = first.listeners.error[0];
    mockScopeGeneration = 'scope-b';
    rerender({ generation: 'scope-b' });
    const second = globalThis.__lastSSEInstance;

    queuedOldError({ type: 'error', xhrStatus: 401 });
    expect(mockClearAuthForScope).not.toHaveBeenCalled();
    second.triggerError({ xhrStatus: 401 });
    expect(mockClearAuthForScope).toHaveBeenCalledTimes(1);
    expect(mockClearAuthForScope.mock.calls[0][0].generation).toBe('scope-b');
  });
});
