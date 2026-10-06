/** Pagination, timeline projection, viewport clamp 계약. */
import { act, renderHook } from '@testing-library/react-native';
import type { HistoricalMessage, MessagesResponse } from '../../../api/client';
import type { SessionEvent } from '../../../api/types';
import { useChatHistoryPagination } from '../useChatHistoryPagination';
import {
  cleanupChatHistoryTest,
  makeApi,
  makeDeps,
  makeFlatListRef,
  makeHistoricalMessage,
  resetChatHistoryTestScope,
  SID_A,
  useFakeTimersForTest,
} from '../test-helpers/useChatHistoryPagination';

describe('useChatHistoryPagination pagination', () => {
  beforeEach(resetChatHistoryTestScope);
  afterEach(async () => {
    await cleanupChatHistoryTest();
    jest.restoreAllMocks();
  });

  test('C1 — 마운트 시 첫 페이지 fetch (api.getTimeline 1회 + mergeEvents + setLastEventId)', async () => {
    const messages: HistoricalMessage[] = [
      makeHistoricalMessage(2),
      makeHistoricalMessage(1),
    ]; // DESC (서버 wire 형식)
    const api = makeApi(async () => ({ messages, next_cursor: null }));
    const mergeEvents = jest.fn();
    const setLastEventId = jest.fn();
    const deps = makeDeps({ api, sessionId: SID_A, mergeEvents, setLastEventId });

    renderHook(() => useChatHistoryPagination(deps));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(api.getTimeline).toHaveBeenCalledTimes(1);
    expect(api.getTimeline).toHaveBeenCalledWith(
      SID_A,
      expect.objectContaining({ limit: 100, before: undefined }),
    );
    expect(api.getTimeline.mock.calls[0][1]).not.toHaveProperty('eventTypes');
    expect(mergeEvents).toHaveBeenCalledTimes(1);
    // ASC reverse — id 1, 2 순서 (시간순)
    const passedEvents = mergeEvents.mock.calls[0][1] as SessionEvent[];
    expect(passedEvents.map((e) => e.id)).toEqual(['1', '2']);
    // 첫 페이지(before=undefined) → setLastEventId(가장 최신=마지막)
    expect(setLastEventId).toHaveBeenCalledWith(SID_A, '2');
  });

  test('원고형 이력 조회는 지정된 eventTypes를 각 페이지에 전달한다', async () => {
    const eventTypes = ['user_message', 'context_usage', 'complete'];
    const api = makeApi(async () => ({ messages: [], next_cursor: null }));
    const deps = makeDeps({ api, sessionId: SID_A, timelineEventTypes: eventTypes });

    renderHook(() => useChatHistoryPagination(deps));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(api.getTimeline).toHaveBeenCalledWith(
      SID_A,
      expect.objectContaining({ eventTypes }),
    );
  });

  test('C1b — semantic timeline의 assistant_message만으로 완료 말풍선을 병합한다', async () => {
    const messages: HistoricalMessage[] = [
      {
        id: 10,
        parent_event_id: null,
        event_type: 'assistant_message',
        payload: {
          type: 'assistant_message',
          content: 'completed assistant answer',
        },
        created_at: new Date().toISOString(),
      },
    ];
    const api = makeApi(async () => ({ messages, next_cursor: null }));
    const mergeEvents = jest.fn();
    const deps = makeDeps({ api, sessionId: SID_A, mergeEvents });

    renderHook(() => useChatHistoryPagination(deps));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const passedEvents = mergeEvents.mock.calls[0][1] as SessionEvent[];
    expect(passedEvents).toHaveLength(1);
    expect(passedEvents[0]).toMatchObject({
      id: '10',
      type: 'assistant_message',
      data: {
        type: 'assistant_message',
        content: 'completed assistant answer',
      },
    });
  });

  test('C1c — runtime/hook/mode history 이벤트는 상태에만 적용하고 채팅 타임라인에는 병합하지 않는다', async () => {
    const messages: HistoricalMessage[] = [
      {
        id: 3,
        parent_event_id: null,
        event_type: 'claude_runtime_mode_state',
        payload: { mode: 'plan', active: true },
        created_at: new Date().toISOString(),
      },
      {
        id: 2,
        parent_event_id: null,
        event_type: 'assistant_message',
        payload: {
          type: 'assistant_message',
          content: 'visible answer',
        },
        created_at: new Date().toISOString(),
      },
      {
        id: 1,
        parent_event_id: null,
        event_type: 'claude_runtime_hook_event',
        payload: { hook_event_name: 'PermissionRequest' },
        created_at: new Date().toISOString(),
      },
    ];
    const api = makeApi(async () => ({ messages, next_cursor: null }));
    const mergeEvents = jest.fn();
    const setLastEventId = jest.fn();
    const applyStateOnlyEvent = jest.fn();
    const deps = makeDeps({
      api,
      sessionId: SID_A,
      mergeEvents,
      setLastEventId,
      applyStateOnlyEvent,
    });

    renderHook(() => useChatHistoryPagination(deps));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const passedEvents = mergeEvents.mock.calls[0][1] as SessionEvent[];
    expect(passedEvents.map((event) => event.type)).toEqual([
      'assistant_message',
    ]);
    expect(applyStateOnlyEvent).toHaveBeenCalledTimes(2);
    expect(applyStateOnlyEvent).toHaveBeenCalledWith(
      SID_A,
      'claude_runtime_hook_event',
      { hook_event_name: 'PermissionRequest' },
    );
    expect(applyStateOnlyEvent).toHaveBeenCalledWith(
      SID_A,
      'claude_runtime_mode_state',
      { mode: 'plan', active: true },
    );
    expect(setLastEventId).toHaveBeenCalledWith(SID_A, '3');
  });

  test('C2 — next_cursor=null이면 reachedTop=true, mvcpEnabled=true', async () => {
    const api = makeApi(async () => ({ messages: [makeHistoricalMessage(1)], next_cursor: null }));
    const deps = makeDeps({ api, sessionId: SID_A });

    const { result } = renderHook(() => useChatHistoryPagination(deps));
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.reachedTop).toBe(true);
    expect(result.current.mvcpEnabled).toBe(true);
    expect(result.current.historyLoading).toBe(false);
  });

  test('C3 — requestOlder가 frontier set 후 추가 fetch (F-H-1 사용자 트리거)', async () => {
    // 마운트 fetch + autoSupplement fetch가 자동 발화하므로, 이 두 번 후에도 cursor가
    // 살아있도록 응답을 설계 — requestOlder 발화 시 세 번째 fetch가 발생.
    let callCount = 0;
    const api = makeApi(async () => {
      callCount += 1;
      return {
        messages: [makeHistoricalMessage(callCount * 10)],
        next_cursor: callCount < 3 ? `cursor-${callCount}` : null,
      };
    });
    const flatListRef = makeFlatListRef();
    const deps = makeDeps({ api, sessionId: SID_A, flatListRef });

    const { result } = renderHook(() => useChatHistoryPagination(deps));
    // 마운트 fetch + autoSupplement fetch 모두 처리
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    const callsAfterAutoSupplement = api.getTimeline.mock.calls.length;
    expect(callsAfterAutoSupplement).toBe(2);
    // historyCursor='cursor-2' (두 번째 응답의 next_cursor)

    // onScroll로 lastScrollOffset 갱신
    act(() => {
      result.current.onScroll({
        nativeEvent: { contentOffset: { y: 1234 } },
      } as any);
    });
    // requestOlder 호출 → frontier=1234 set + fetch(cursor-2)
    await act(async () => {
      result.current.requestOlder();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(api.getTimeline.mock.calls.length).toBe(callsAfterAutoSupplement + 1);
    const lastCall = api.getTimeline.mock.calls[api.getTimeline.mock.calls.length - 1];
    expect(lastCall[1]).toMatchObject({ before: 'cursor-2' });
  });

  test('C4 — onScroll이 frontier 초과 시 scrollToOffset(frontier) clamp', async () => {
    let callCount = 0;
    const api = makeApi(async (_sid, params) => {
      callCount += 1;
      // 항상 cursor 반환 — autoSupplement 발화 시 in-flight로 frontier 활성 유지 안 됨
      // → fetch가 끝나기 전 강제로 onScroll 발화 시점을 만들어야 함
      return new Promise<MessagesResponse>((resolve, reject) => {
        const signal = params.signal as AbortSignal | undefined;
        const onAbort = () => {
          clearTimeout(timer);
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        };
        const timer = setTimeout(
          () => {
            signal?.removeEventListener('abort', onAbort);
            resolve({
              messages: [makeHistoricalMessage(callCount * 10)],
              next_cursor: callCount < 3 ? `cursor-${callCount}` : null,
            });
          },
          callCount === 1 ? 0 : 5000, // 두 번째부터는 응답을 늦춤 → in-flight 유지
        );
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) onAbort();
      });
    });
    useFakeTimersForTest();
    const flatListRef = makeFlatListRef();
    const deps = makeDeps({ api, sessionId: SID_A, flatListRef });

    const { result, unmount } = renderHook(() => useChatHistoryPagination(deps));
    // 첫 페이지 응답 처리 — setTimeout 0
    await act(async () => {
      jest.advanceTimersByTime(0);
      await Promise.resolve();
      await Promise.resolve();
    });

    // requestOlder 발사 — 첫 onScroll로 lastScrollOffset=500 set
    act(() => {
      result.current.onScroll({
        nativeEvent: { contentOffset: { y: 500 } },
      } as any);
    });
    await act(async () => {
      result.current.requestOlder();
      await Promise.resolve();
    });
    // 두 번째 fetch는 setTimeout 5000으로 in-flight 상태 — frontier=500 활성

    const scrollToOffset = (flatListRef.current as any).scrollToOffset as jest.Mock;
    scrollToOffset.mockClear();

    // 사용자가 빠르게 위로 scroll — offset 800은 frontier 500을 초과
    act(() => {
      result.current.onScroll({
        nativeEvent: { contentOffset: { y: 800 } },
      } as any);
    });

    expect(scrollToOffset).toHaveBeenCalledTimes(1);
    expect(scrollToOffset).toHaveBeenCalledWith({ offset: 500, animated: false });

    // 두 번째 5초 mock response가 남은 상태에서 훅을 먼저 unmount한다. abort-aware
    // mock이 timer를 지우고 promise를 reject하며, 훅은 stale request라 state를 쓰지 않는다.
    act(() => {
      unmount();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    // unmount/abort 뒤에는 callback을 실행할 이유가 없다. RN rAF까지 명시적으로
    // 폐기한 뒤 real timer로 돌아가야 jest.now callback이 teardown 뒤 남지 않는다.
    jest.clearAllTimers();
    expect(jest.getTimerCount()).toBe(0);
  });

  test('C5 — autoSupplement: next_cursor non-null이면 첫 페이지 응답 후 1회 자동 fetch', async () => {
    let callCount = 0;
    const api = makeApi(async () => {
      callCount += 1;
      return {
        messages: [makeHistoricalMessage(callCount)],
        next_cursor: callCount < 2 ? `cursor-${callCount}` : null,
      };
    });
    const deps = makeDeps({ api, sessionId: SID_A });

    renderHook(() => useChatHistoryPagination(deps));
    await act(async () => {
      // 첫 페이지 응답 + autoSupplement effect 발화 + 두 번째 fetch
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // 마운트 fetch + autoSupplement fetch = 2회
    expect(api.getTimeline.mock.calls.length).toBeGreaterThanOrEqual(2);
    const calls = api.getTimeline.mock.calls;
    expect(calls[0][1]).toMatchObject({ before: undefined });
    expect(calls[1][1]).toMatchObject({ before: 'cursor-1' });
  });

  test.each([
    {
      name: '현재 cursor 반복',
      secondPage: {
        messages: [makeHistoricalMessage(2)],
        next_cursor: 'cursor-1',
      },
    },
    {
      name: '빈 페이지인데 다음 cursor 존재',
      secondPage: {
        messages: [],
        next_cursor: 'cursor-2',
      },
    },
  ])('C6 — $name 응답은 자동 페이지 탐색을 오류 상태에서 멈춘다', async ({ secondPage }) => {
    const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    let callCount = 0;
    const api = makeApi(async () => {
      callCount += 1;
      return callCount === 1
        ? { messages: [makeHistoricalMessage(1)], next_cursor: 'cursor-1' }
        : secondPage;
    });
    const { result } = renderHook(() =>
      useChatHistoryPagination(makeDeps({ api, sessionId: SID_A })),
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(api.getTimeline).toHaveBeenCalledTimes(2);
    expect(api.getTimeline.mock.calls[1][1]).toMatchObject({ before: 'cursor-1' });
    expect(result.current.hasFetchError).toBe(true);
    expect(result.current.historyLoading).toBe(false);
    expect(result.current.reachedTop).toBe(false);
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      '[useChatHistoryPagination] invalid history cursor response:',
      expect.objectContaining({ before: 'cursor-1' }),
    );
  });

  test('C7 — 이전에 발급된 cursor가 돌아오면 검색용 과거 탐색을 오류 상태에서 멈춘다', async () => {
    const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const cursors = ['cursor-a', 'cursor-b', 'cursor-a'];
    let callCount = 0;
    const api = makeApi(async (_sid, params) => ({
      messages: [makeHistoricalMessage(++callCount)],
      next_cursor: cursors[callCount - 1] ?? null,
    }));
    const { result } = renderHook(() =>
      useChatHistoryPagination(makeDeps({ api, sessionId: SID_A })),
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(api.getTimeline).toHaveBeenCalledTimes(2);
    await act(async () => {
      result.current.requestOlder();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(api.getTimeline).toHaveBeenCalledTimes(3);
    expect(api.getTimeline.mock.calls.map((call) => call[1].before)).toEqual([
      undefined,
      'cursor-a',
      'cursor-b',
    ]);
    expect(result.current.hasFetchError).toBe(true);
    expect(result.current.historyLoading).toBe(false);
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      '[useChatHistoryPagination] invalid history cursor response:',
      expect.objectContaining({ before: 'cursor-b', nextCursor: 'cursor-a' }),
    );
  });

});
