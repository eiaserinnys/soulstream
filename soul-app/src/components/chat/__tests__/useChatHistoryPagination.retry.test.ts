/** 자동·수동 retry와 영구 실패 표면 계약. */
import { act, renderHook } from '@testing-library/react-native';
import { useChatHistoryPagination } from '../useChatHistoryPagination';
import {
  cleanupChatHistoryTest,
  makeApi,
  makeDeps,
  makeHistoricalMessage,
  resetChatHistoryTestScope,
  SID_A,
  useFakeTimersForTest,
} from '../test-helpers/useChatHistoryPagination';

describe('useChatHistoryPagination retry', () => {
  beforeEach(resetChatHistoryTestScope);
  afterEach(cleanupChatHistoryTest);

  test('C6 — fetch 실패 → 1초 후 자동 retry 1회 (F-H-2)', async () => {
    useFakeTimersForTest();
    let callCount = 0;
    const api = makeApi(async () => {
      callCount += 1;
      throw new Error(`fail-${callCount}`);
    });
    const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const deps = makeDeps({ api, sessionId: SID_A });

    renderHook(() => useChatHistoryPagination(deps));
    // 첫 페이지 fetch 발사 + reject 처리
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(api.getTimeline).toHaveBeenCalledTimes(1);

    // 1초 advance → retry 발화
    await act(async () => {
      jest.advanceTimersByTime(1000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(api.getTimeline).toHaveBeenCalledTimes(2);

    consoleWarnSpy.mockRestore();
  });

  test('C7 — retry 1회 후에도 실패하면 silent fall-through (3번째 호출 없음)', async () => {
    useFakeTimersForTest();
    const api = makeApi(async () => {
      throw new Error('persistent-failure');
    });
    const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const deps = makeDeps({ api, sessionId: SID_A });

    renderHook(() => useChatHistoryPagination(deps));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    // 1차 fetch 실패 → retry 예약
    expect(api.getTimeline).toHaveBeenCalledTimes(1);

    // 1초 advance → retry 발화 → 또 실패
    await act(async () => {
      jest.advanceTimersByTime(1000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(api.getTimeline).toHaveBeenCalledTimes(2);

    // 추가 시간이 지나도 더 이상 호출 없음 (retryCountRef === 1로 가드)
    await act(async () => {
      jest.advanceTimersByTime(5000);
      await Promise.resolve();
    });
    expect(api.getTimeline).toHaveBeenCalledTimes(2);

    consoleWarnSpy.mockRestore();
  });

  test('C10 — retry 1회 후에도 실패하면 hasFetchError=true (영구 실패 명시)', async () => {
    useFakeTimersForTest();
    const api = makeApi(async () => {
      throw new Error('persistent-failure');
    });
    const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const deps = makeDeps({ api, sessionId: SID_A });

    const { result } = renderHook(() => useChatHistoryPagination(deps));
    // 1차 fetch 실패 → retry 예약 — 이 시점 hasFetchError=false (자동 retry 진행 예정)
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(api.getTimeline).toHaveBeenCalledTimes(1);
    expect(result.current.hasFetchError).toBe(false);

    // 1초 advance → retry 발화 → 또 실패 → 이제 hasFetchError=true
    await act(async () => {
      jest.advanceTimersByTime(1000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(api.getTimeline).toHaveBeenCalledTimes(2);
    expect(result.current.hasFetchError).toBe(true);

    consoleWarnSpy.mockRestore();
  });

  test('C11 — retryFromError 호출 시 hasFetchError=false + loadHistoryPage 재발화 + retryCountRef reset', async () => {
    useFakeTimersForTest();
    const api = makeApi(async () => {
      throw new Error('persistent-failure');
    });
    const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const deps = makeDeps({ api, sessionId: SID_A });

    const { result } = renderHook(() => useChatHistoryPagination(deps));
    // C10 시나리오로 hasFetchError=true 도달
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      jest.advanceTimersByTime(1000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.hasFetchError).toBe(true);
    const callsBeforeRetry = api.getTimeline.mock.calls.length;

    // 사용자 수동 재시도
    await act(async () => {
      result.current.retryFromError();
      await Promise.resolve();
      await Promise.resolve();
    });

    // hasFetchError 즉시 reset
    expect(result.current.hasFetchError).toBe(false);
    // 새로운 fetch 발사 — 1회 추가
    expect(api.getTimeline.mock.calls.length).toBe(callsBeforeRetry + 1);

    // retryCountRef = 0 reset 검증: 새 fetch 또 실패 시 1초 후 자동 retry 다시 가능
    await act(async () => {
      jest.advanceTimersByTime(1000);
      await Promise.resolve();
      await Promise.resolve();
    });
    // 수동 fetch + 자동 retry 1회 = 2회 추가
    expect(api.getTimeline.mock.calls.length).toBe(callsBeforeRetry + 2);

    consoleWarnSpy.mockRestore();
  });

  test('C12 — retryFromError 후 fetch 성공 시 hasFetchError=false 자동 reset (success branch)', async () => {
    useFakeTimersForTest();
    let callCount = 0;
    const api = makeApi(async () => {
      callCount += 1;
      if (callCount <= 2) {
        // 처음 2회(1차 + 자동 retry)는 실패
        throw new Error('temporary-failure');
      }
      // 3회차(수동 재시도)는 성공
      return { messages: [makeHistoricalMessage(callCount)], next_cursor: null };
    });
    const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const deps = makeDeps({ api, sessionId: SID_A });

    const { result } = renderHook(() => useChatHistoryPagination(deps));
    // 1차 + 자동 retry 모두 실패 → hasFetchError=true
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      jest.advanceTimersByTime(1000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.hasFetchError).toBe(true);

    // 수동 재시도 → 3회차 fetch 성공
    await act(async () => {
      result.current.retryFromError();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // 성공 시 hasFetchError=false 자동 reset (try success branch)
    expect(result.current.hasFetchError).toBe(false);
    expect(result.current.reachedTop).toBe(true);

    consoleWarnSpy.mockRestore();
  });

});
