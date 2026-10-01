/** 고정 auth scope와 cleanup 전 응답 경합 계약. */
import { act, renderHook } from '@testing-library/react-native';
import type { MessagesResponse } from '../../../api/client';
import { captureAuthScope, type AuthScopeSnapshot } from '../../../lib/auth-scope';
import { useAuthStore } from '../../../store/authStore';
import { useChatHistoryPagination } from '../useChatHistoryPagination';
import {
  cleanupChatHistoryTest,
  deferred,
  makeApi,
  makeDeps,
  makeFlatListRef,
  makeHistoricalMessage,
  resetChatHistoryTestScope,
  SID_A,
} from '../test-helpers/useChatHistoryPagination';

describe('useChatHistoryPagination auth scope', () => {
  beforeEach(resetChatHistoryTestScope);
  afterEach(cleanupChatHistoryTest);

  test('auth generation 변경 시 same server/session old REST 응답을 폐기하고 B 첫 페이지만 반영한다', async () => {
    const oldPage = deferred<MessagesResponse>();
    const newPage = deferred<MessagesResponse>();
    const api = makeApi();
    api.getTimeline
      .mockImplementationOnce(() => oldPage.promise)
      .mockImplementationOnce(() => newPage.promise);
    const mergeEvents = jest.fn();
    const scopeA = captureAuthScope();
    const { rerender } = renderHook<
      ReturnType<typeof useChatHistoryPagination>,
      { authScope: AuthScopeSnapshot }
    >(
      ({ authScope }) => useChatHistoryPagination(makeDeps({
        api,
        sessionId: SID_A,
        authScope,
        mergeEvents,
      })),
      { initialProps: { authScope: scopeA } },
    );
    expect(api.getTimeline).toHaveBeenCalledTimes(1);

    useAuthStore.getState().setJwt('scope-b-jwt');
    const scopeB = captureAuthScope();
    rerender({ authScope: scopeB });
    expect(api.getTimeline).toHaveBeenCalledTimes(2);

    await act(async () => {
      newPage.resolve({ messages: [makeHistoricalMessage(20)], next_cursor: null });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mergeEvents).toHaveBeenCalledTimes(1);
    expect(mergeEvents.mock.calls[0][1][0].id).toBe('20');

    await act(async () => {
      oldPage.resolve({ messages: [makeHistoricalMessage(10)], next_cursor: null });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mergeEvents).toHaveBeenCalledTimes(1);
  });

  test('effect cleanup 전 auth scope가 바뀌면 abort를 무시한 이전 응답의 모든 write를 폐기한다', async () => {
    const oldPage = deferred<MessagesResponse>();
    const api = makeApi(() => oldPage.promise);
    const mergeEvents = jest.fn();
    const setLastEventId = jest.fn();
    const flatListRef = makeFlatListRef();
    const scopeA = captureAuthScope();
    const deps = makeDeps({
      api,
      sessionId: SID_A,
      authScope: scopeA,
      mergeEvents,
      setLastEventId,
      flatListRef,
    });
    const { result } = renderHook(() => useChatHistoryPagination(deps));
    expect(api.getTimeline).toHaveBeenCalledTimes(1);

    // React rerender/effect cleanup 없이 전역 auth generation만 먼저 B로 전환한다.
    useAuthStore.getState().setJwt('scope-b-jwt');
    expect(captureAuthScope().generation).not.toBe(scopeA.generation);

    await act(async () => {
      oldPage.resolve({
        messages: [makeHistoricalMessage(10)],
        next_cursor: null,
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mergeEvents).not.toHaveBeenCalled();
    expect(setLastEventId).not.toHaveBeenCalled();
    expect(result.current.reachedTop).toBe(false);
    expect(result.current.mvcpEnabled).toBe(false);
    expect(result.current.hasFetchError).toBe(false);
    expect(result.current.historyLoading).toBe(true);
    expect(flatListRef.current?.scrollToOffset).not.toHaveBeenCalled();
  });
});
