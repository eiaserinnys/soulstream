/** 세션 전환, unmount, timer/RAF lifecycle 계약. */
import { act, renderHook } from '@testing-library/react-native';
import type { MessagesResponse } from '../../../api/client';
import { useChatHistoryPagination } from '../useChatHistoryPagination';
import {
  cleanupChatHistoryTest,
  deferred,
  makeApi,
  makeDeps,
  makeFlatListRef,
  makeHistoricalMessage,
  makeRefs,
  resetChatHistoryTestScope,
  SID_A,
  SID_B,
  useFakeTimersForTest,
} from '../test-helpers/useChatHistoryPagination';

describe('useChatHistoryPagination lifecycle', () => {
  beforeEach(resetChatHistoryTestScope);
  afterEach(cleanupChatHistoryTest);

  test('C8 — 세션 전환 시 retry timeout cleared (cross-session 차단)', async () => {
    useFakeTimersForTest();
    const api = makeApi(async (sid) => {
      if (sid === SID_A) throw new Error('a-fail');
      return { messages: [], next_cursor: null };
    });
    const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    let currentSid: string | undefined = SID_A;
    const { rerender } = renderHook<
      ReturnType<typeof useChatHistoryPagination>,
      { sessionId: string | undefined }
    >(
      (props: { sessionId: string | undefined }) =>
        useChatHistoryPagination(makeDeps({ api, sessionId: props.sessionId })),
      { initialProps: { sessionId: currentSid } as any },
    );

    // 세션 A: 첫 fetch 실패 → retry 예약 (1초 후)
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const callsAfterA = api.getTimeline.mock.calls.length;
    expect(callsAfterA).toBe(1);

    // retry timeout 만료 *전*에 세션 B로 전환
    currentSid = SID_B;
    await act(async () => {
      rerender({ sessionId: currentSid } as any);
      await Promise.resolve();
      await Promise.resolve();
    });
    // 세션 B 첫 fetch 발사 (1회 추가)
    const callsAfterB = api.getTimeline.mock.calls.length;

    // 1초 advance — A의 retry timeout이 cleared되었으면 A 호출 추가 0
    await act(async () => {
      jest.advanceTimersByTime(2000);
      await Promise.resolve();
    });
    // 추가 호출은 *없어야* 함 (B의 first fetch는 위에서 이미 카운트됨, 그 외 호출 X)
    const callsAfterAdvance = api.getTimeline.mock.calls.length;
    expect(callsAfterAdvance).toBe(callsAfterB);

    // 세션 A로 retry가 발화되지 않았음을 확인 — A로의 추가 호출 0
    const aCalls = api.getTimeline.mock.calls.filter((c) => c[0] === SID_A);
    expect(aCalls.length).toBe(1); // 최초 1회만

    consoleWarnSpy.mockRestore();
  });

  test('C8b — unmount가 retry timeout을 취소해 teardown 뒤 재시도하지 않는다', async () => {
    useFakeTimersForTest();
    const api = makeApi(async () => {
      throw new Error('unmount-failure');
    });
    const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const deps = makeDeps({ api, sessionId: SID_A });
    const { unmount } = renderHook(() => useChatHistoryPagination(deps));

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(api.getTimeline).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBeGreaterThan(0);

    act(() => {
      unmount();
    });
    await act(async () => {
      await Promise.resolve();
    });

    // 1초를 지나도 unmount된 owner의 retry가 발화하지 않는 것으로 cleanup 계약을
    // 관찰한다. RN의 requestAnimationFrame timer는 sync act 안에서 안전하게 소진한다.
    act(() => {
      jest.advanceTimersByTime(1000);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(api.getTimeline).toHaveBeenCalledTimes(1);
    jest.clearAllTimers();
    expect(jest.getTimerCount()).toBe(0);
    consoleWarnSpy.mockRestore();
  });

  test('C8c — unmount가 pending initial-scroll animation frame을 취소한다', async () => {
    let nextFrameId = 1;
    const scheduledFrames = new Map<
      number,
      Parameters<typeof requestAnimationFrame>[0]
    >();
    const requestFrameSpy = jest
      .spyOn(global, 'requestAnimationFrame')
      .mockImplementation((callback) => {
        const id = nextFrameId;
        nextFrameId += 1;
        scheduledFrames.set(id, callback);
        return id;
      });
    const cancelFrameSpy = jest
      .spyOn(global, 'cancelAnimationFrame')
      .mockImplementation((id) => {
        if (typeof id === 'number') scheduledFrames.delete(id);
      });
    const api = makeApi(async () => ({
      messages: [makeHistoricalMessage(1)],
      next_cursor: null,
    }));
    const deps = makeDeps({ api, sessionId: SID_A });
    const { unmount } = renderHook(() => useChatHistoryPagination(deps));

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(requestFrameSpy).toHaveBeenCalledTimes(1);
    const frameId = requestFrameSpy.mock.results[0].value as number;
    expect(scheduledFrames.has(frameId)).toBe(true);

    act(() => {
      unmount();
    });

    expect(cancelFrameSpy).toHaveBeenCalledWith(frameId);
    expect(scheduledFrames.size).toBe(0);
    requestFrameSpy.mockRestore();
    cancelFrameSpy.mockRestore();
  });

  test('AbortController가 없는 runtime도 unmount 뒤 늦은 REST 응답을 폐기한다', async () => {
    const originalAbortController = (globalThis as any).AbortController;
    (globalThis as any).AbortController = undefined;
    try {
      const pending = deferred<MessagesResponse>();
      const api = makeApi(() => pending.promise);
      const mergeEvents = jest.fn();
      const setLastEventId = jest.fn();
      const { unmount } = renderHook(() => useChatHistoryPagination(makeDeps({
        api,
        sessionId: SID_A,
        mergeEvents,
        setLastEventId,
      })));
      await act(async () => { await Promise.resolve(); });

      unmount();
      await act(async () => {
        pending.resolve({ messages: [makeHistoricalMessage(77)], next_cursor: null });
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(mergeEvents).not.toHaveBeenCalled();
      expect(setLastEventId).not.toHaveBeenCalled();
    } finally {
      (globalThis as any).AbortController = originalAbortController;
    }
  });

  test('history finally의 queued SSE commit 실패는 즉시 transport failure로 전달한다', async () => {
    const pending = deferred<MessagesResponse>();
    const api = makeApi(() => pending.promise);
    const refs = makeRefs();
    refs.isCatchingUpRef.current = false;
    refs.pendingLiveQueueRef.current.push({
      event: { id: '41', type: 'system', data: { message: 'must replay' } },
      eid: '41',
    });
    const mergeEvents = jest.fn(() => {
      throw new Error('queued SSE commit failed');
    });
    const setLastEventId = jest.fn();
    const onAsyncCommitError = jest.fn();
    renderHook(() => useChatHistoryPagination(makeDeps({
      api,
      sessionId: SID_A,
      refs,
      mergeEvents,
      setLastEventId,
      onAsyncCommitError,
    })));
    await act(async () => { await Promise.resolve(); });

    await act(async () => {
      pending.resolve({ messages: [], next_cursor: null });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onAsyncCommitError).toHaveBeenCalledWith(expect.objectContaining({
      message: 'queued SSE commit failed',
    }));
    expect(refs.pendingLiveQueueRef.current.map((item) => item.eid))
      .toEqual(['41']);
    expect(setLastEventId).not.toHaveBeenCalledWith(SID_A, '41');
  });

  test('C9 — 세션 전환 시 frontier·lastScrollOffset 리셋 (다음 세션 첫 fetch 시 frontier null)', async () => {
    let callCount = 0;
    const api = makeApi(async () => {
      callCount += 1;
      return {
        messages: [makeHistoricalMessage(callCount)],
        next_cursor: null,
      };
    });
    const flatListRef = makeFlatListRef();

    const { result, rerender } = renderHook(
      (props: { sessionId: string | undefined }) =>
        useChatHistoryPagination(
          makeDeps({ api, sessionId: props.sessionId, flatListRef }),
        ),
      { initialProps: { sessionId: SID_A } as any },
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // 세션 A에서 onScroll 갱신 → lastScrollOffset=500
    act(() => {
      result.current.onScroll({
        nativeEvent: { contentOffset: { y: 500 } },
      } as any);
    });

    // 세션 B로 전환
    await act(async () => {
      rerender({ sessionId: SID_B } as any);
      await Promise.resolve();
      await Promise.resolve();
    });

    // 세션 B에서 onScroll(0) → 만약 lastScrollOffset 리셋이 안 됐으면 frontier가 500이라
    // offset 100은 frontier 미만이라 clamp 발화 X. 리셋이 됐다면 frontier null이라 clamp X.
    // → 어느 쪽이든 onScroll 자체는 clamp 발화 없음. 본 케이스는 *frontier 미설정 상태에서
    // 세션 B 첫 fetch가 발사되었음*을 검증한다.
    const bCalls = api.getTimeline.mock.calls.filter((c) => c[0] === SID_B);
    expect(bCalls.length).toBe(1);
    expect(bCalls[0][1]).toMatchObject({ before: undefined });

    // 세션 B에서 onScroll로 추가 진입 — frontier=null이므로 clamp 미발화
    const scrollToOffset = (flatListRef.current as any).scrollToOffset as jest.Mock;
    scrollToOffset.mockClear();
    act(() => {
      result.current.onScroll({
        nativeEvent: { contentOffset: { y: 9999 } },
      } as any);
    });
    expect(scrollToOffset).not.toHaveBeenCalled();
  });

  test('C9b — 세션 A fetch가 pending이어도 세션 B 첫 fetch가 막히지 않고 A stale finally가 B 큐를 flush하지 않는다', async () => {
    const pendingA = deferred<MessagesResponse>();
    const pendingB = deferred<MessagesResponse>();
    const api = makeApi((sid) => {
      if (sid === SID_A) return pendingA.promise;
      if (sid === SID_B) return pendingB.promise;
      throw new Error(`unexpected sid ${sid}`);
    });
    const refs = makeRefs();
    const mergeEvents = jest.fn();
    const setLastEventId = jest.fn();
    const triggerAnimation = jest.fn();

    const { rerender } = renderHook<
      ReturnType<typeof useChatHistoryPagination>,
      { sessionId: string | undefined }
    >(
      (props: { sessionId: string | undefined }) =>
        useChatHistoryPagination(
          makeDeps({
            api,
            sessionId: props.sessionId,
            refs,
            mergeEvents,
            setLastEventId,
            triggerAnimation,
          }),
        ),
      { initialProps: { sessionId: SID_A } as any },
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(api.getTimeline).toHaveBeenCalledWith(
      SID_A,
      expect.objectContaining({ limit: 100, before: undefined }),
    );

    await act(async () => {
      rerender({ sessionId: SID_B } as any);
      await Promise.resolve();
    });
    expect(api.getTimeline).toHaveBeenCalledWith(
      SID_B,
      expect.objectContaining({ limit: 100, before: undefined }),
    );

    refs.pendingLiveQueueRef.current = [
      {
        event: { id: '500', type: 'assistant_message', data: { content: 'b-live' } },
        eid: '500',
      },
    ];

    await act(async () => {
      pendingA.resolve({
        messages: [makeHistoricalMessage(1)],
        next_cursor: null,
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mergeEvents).not.toHaveBeenCalledWith(
      SID_A,
      expect.any(Array),
    );
    expect(mergeEvents).not.toHaveBeenCalledWith(
      SID_B,
      [{ id: '500', type: 'assistant_message', data: { content: 'b-live' } }],
    );
    expect(refs.pendingLiveQueueRef.current).toHaveLength(1);
    expect(triggerAnimation).not.toHaveBeenCalled();

    await act(async () => {
      pendingB.resolve({
        messages: [makeHistoricalMessage(200)],
        next_cursor: null,
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mergeEvents).toHaveBeenCalledWith(
      SID_B,
      expect.arrayContaining([
        expect.objectContaining({ id: '200' }),
      ]),
    );
    expect(mergeEvents).toHaveBeenCalledWith(
      SID_B,
      [{ id: '500', type: 'assistant_message', data: { content: 'b-live' } }],
    );
    expect(setLastEventId).toHaveBeenCalledWith(SID_B, '500');
  });

  test('A→B→A 전환은 마지막 A owner 응답만 A store와 cursor에 반영한다', async () => {
    const firstA = deferred<MessagesResponse>();
    const pendingB = deferred<MessagesResponse>();
    const secondA = deferred<MessagesResponse>();
    let aCalls = 0;
    const api = makeApi((sid) => {
      if (sid === SID_B) return pendingB.promise;
      aCalls += 1;
      return aCalls === 1 ? firstA.promise : secondA.promise;
    });
    const mergeEvents = jest.fn();
    const setLastEventId = jest.fn();
    const { rerender } = renderHook(
      (props: { sessionId: string }) => useChatHistoryPagination(makeDeps({
        api,
        sessionId: props.sessionId,
        mergeEvents,
        setLastEventId,
      })),
      { initialProps: { sessionId: SID_A } },
    );
    await act(async () => { await Promise.resolve(); });
    rerender({ sessionId: SID_B });
    await act(async () => { await Promise.resolve(); });
    rerender({ sessionId: SID_A });
    await act(async () => { await Promise.resolve(); });

    await act(async () => {
      firstA.resolve({ messages: [makeHistoricalMessage(1)], next_cursor: null });
      pendingB.resolve({ messages: [makeHistoricalMessage(2)], next_cursor: null });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mergeEvents).not.toHaveBeenCalled();
    expect(setLastEventId).not.toHaveBeenCalled();

    await act(async () => {
      secondA.resolve({ messages: [makeHistoricalMessage(3)], next_cursor: null });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mergeEvents).toHaveBeenCalledWith(
      SID_A,
      [expect.objectContaining({ id: '3' })],
    );
    expect(setLastEventId).toHaveBeenCalledWith(SID_A, '3');
  });

  test('snapshotGeneration 증가 시 같은 세션의 첫 페이지를 다시 로드한다', async () => {
    const api = makeApi(async () => ({
      messages: [],
      next_cursor: null,
    }));
    const { rerender } = renderHook(
      (props: { snapshotGeneration: number }) =>
        useChatHistoryPagination(
          makeDeps({
            api,
            sessionId: SID_A,
            snapshotGeneration: props.snapshotGeneration,
          }),
        ),
      { initialProps: { snapshotGeneration: 0 } },
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(api.getTimeline).toHaveBeenCalledTimes(1);

    await act(async () => {
      rerender({ snapshotGeneration: 0 });
      await Promise.resolve();
    });
    expect(api.getTimeline).toHaveBeenCalledTimes(1);

    await act(async () => {
      rerender({ snapshotGeneration: 1 });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(api.getTimeline).toHaveBeenCalledTimes(2);
    expect(api.getTimeline).toHaveBeenLastCalledWith(
      SID_A,
      expect.objectContaining({ limit: 100, before: undefined }),
    );
  });

  test('inactive mount는 fetch하지 않고 최초 active에서 한 번만 로드하며 재활성화는 중복 로드하지 않는다', async () => {
    const api = makeApi(async () => ({ messages: [], next_cursor: null }));
    const { rerender } = renderHook(
      (props: { active: boolean }) =>
        useChatHistoryPagination(makeDeps({ api, sessionId: SID_A, active: props.active })),
      { initialProps: { active: false } },
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(api.getTimeline).not.toHaveBeenCalled();

    await act(async () => {
      rerender({ active: true });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(api.getTimeline).toHaveBeenCalledTimes(1);

    await act(async () => {
      rerender({ active: false });
      rerender({ active: true });
      rerender({ active: true });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(api.getTimeline).toHaveBeenCalledTimes(1);
  });

  test('inactive 전환은 pending REST를 abort하고 늦은 응답을 버리며 재활성화 fetch는 한 번만 발사한다', async () => {
    const first = deferred<MessagesResponse>();
    const second = deferred<MessagesResponse>();
    let call = 0;
    const api = makeApi(() => {
      call += 1;
      return call === 1 ? first.promise : second.promise;
    });
    const mergeEvents = jest.fn();
    const onInitialPageCommitted = jest.fn();
    const { rerender } = renderHook(
      (props: { active: boolean }) => useChatHistoryPagination(makeDeps({
        api,
        sessionId: SID_A,
        active: props.active,
        mergeEvents,
        onInitialPageCommitted,
      })),
      { initialProps: { active: true } },
    );

    await act(async () => {
      await Promise.resolve();
    });
    const firstSignal = api.getTimeline.mock.calls[0][1].signal as AbortSignal;

    act(() => {
      rerender({ active: false });
    });
    expect(firstSignal.aborted).toBe(true);

    await act(async () => {
      first.resolve({ messages: [makeHistoricalMessage(1)], next_cursor: null });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mergeEvents).not.toHaveBeenCalled();
    expect(onInitialPageCommitted).not.toHaveBeenCalled();

    await act(async () => {
      rerender({ active: true });
      rerender({ active: true });
      await Promise.resolve();
    });
    expect(api.getTimeline).toHaveBeenCalledTimes(2);

    await act(async () => {
      second.resolve({ messages: [makeHistoricalMessage(2)], next_cursor: null });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mergeEvents).toHaveBeenCalledWith(
      SID_A,
      [expect.objectContaining({ id: '2' })],
    );
    expect(onInitialPageCommitted).toHaveBeenCalledWith(SID_A);
  });

  test('API owner 전환 중 이전 서버 REST 응답은 새 owner store·cursor를 건드리지 않는다', async () => {
    const oldPending = deferred<MessagesResponse>();
    const newPending = deferred<MessagesResponse>();
    const oldApi = makeApi(() => oldPending.promise);
    const newApi = makeApi(() => newPending.promise);
    const mergeEvents = jest.fn();
    const setLastEventId = jest.fn();
    const { rerender } = renderHook(
      (props: { api: ReturnType<typeof makeApi> }) => useChatHistoryPagination(makeDeps({
        api: props.api,
        sessionId: SID_A,
        mergeEvents,
        setLastEventId,
      })),
      { initialProps: { api: oldApi } },
    );

    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      rerender({ api: newApi });
      await Promise.resolve();
    });

    await act(async () => {
      oldPending.resolve({ messages: [makeHistoricalMessage(10)], next_cursor: null });
      await Promise.resolve();
    });
    expect(mergeEvents).not.toHaveBeenCalledWith(
      SID_A,
      [expect.objectContaining({ id: '10' })],
    );
    expect(setLastEventId).not.toHaveBeenCalledWith(SID_A, '10');

    await act(async () => {
      newPending.resolve({ messages: [makeHistoricalMessage(20)], next_cursor: null });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mergeEvents).toHaveBeenCalledWith(
      SID_A,
      [expect.objectContaining({ id: '20' })],
    );
    expect(setLastEventId).toHaveBeenCalledWith(SID_A, '20');
  });

});
