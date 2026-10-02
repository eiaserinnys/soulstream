import { usePersistentDraft } from '../../../hooks/usePersistentDraft';
import { useDraftStore } from '../../../store/draftStore';
import { useAuthStore } from '../../../store/authStore';
import { useSettingsStore } from '../../../store/settingsStore';
/**
 * useChatSendFlow 훅 단위 테스트.
 *
 * 핵심 회귀 가드 — 사용자가 메시지를 송신할 때 scrollToBottom이 1회 호출되어
 * 타이핑 인디케이터가 InputBar에 가려지지 않도록 visual bottom으로 정렬한다.
 *
 * 패턴은 src/hooks/__tests__/useFolderActions.test.ts와 동일 — @testing-library/react-native의
 * renderHook + act. jest-expo preset 호환 (jest.requireActual('react-native') 금지).
 */
import { renderHook, act } from '@testing-library/react-native';
import { Alert } from 'react-native';
import { ApiHttpError } from '../../../api/clientCore';
import { useChatSendFlow } from '../useChatSendFlow';
import { useChatStore } from '../../../store/chatStore';
import type { Session } from '../../../api/types';

const SID = 'sess-test';

function makeSession(status: Session['status'] = 'idle'): Session {
  return {
    agentSessionId: SID,
    nodeId: 'node-1',
    status,
    displayName: 'test session',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function makeApi(overrides: Partial<{ intervene: jest.Mock }> = {}) {
  return {
    intervene: jest.fn().mockResolvedValue({
      delivered: true,
      outcome: 'delivered',
    }),
    ...overrides,
  };
}

function reset() {
  useChatStore.getState().clearSession(SID);
}

describe('useChatSendFlow', () => {
  beforeEach(() => {
    reset();
    jest.clearAllMocks();
    jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('정상 송신: scrollToBottom 1회 + api.intervene 1회 + onCleared·clearAttachments 호출', async () => {
    const api = makeApi();
    const scrollToBottom = jest.fn();
    const clearAttachments = jest.fn();
    const onCleared = jest.fn();
    const { result } = renderHook(() =>
      useChatSendFlow({
        api: api as any,
        sessionId: SID,
        session: makeSession('idle'),
        attachments: [],
        clearAttachments,
        scrollToBottom,
      })
    );
    await act(async () => {
      await result.current.handleSend('안녕하세요', onCleared);
    });
    expect(scrollToBottom).toHaveBeenCalledTimes(1);
    expect(api.intervene).toHaveBeenCalledTimes(1);
    expect(api.intervene).toHaveBeenCalledWith(SID, '안녕하세요', undefined);
    expect(onCleared).toHaveBeenCalledTimes(1);
    expect(clearAttachments).toHaveBeenCalledTimes(1);
    // pendingOptimistic 슬롯에 placeholder 설정
    expect(useChatStore.getState().pendingOptimisticBySession[SID]).toBeDefined();
    // HTTP 응답은 왔지만 서버 이벤트 전이므로 pending cell은 계속 sending이다.
    expect(result.current.sending).toBe(true);
    expect(result.current.sendError).toBeNull();
    expect((useChatStore.getState().pendingOptimisticBySession[SID] as any).pendingStatus).toBe('sending');
  });

  test('송신 계측에는 길이·결과만 넘기고 원문은 넘기지 않는다', async () => {
    const api = makeApi({
      intervene: jest.fn().mockResolvedValue({
        delivered: true,
        outcome: 'delivered',
        sessionEventId: 44,
      }),
    });
    const onUsageEvent = jest.fn();
    const { result } = renderHook(() => useChatSendFlow({
      api: api as any,
      sessionId: SID,
      session: makeSession(),
      attachments: [],
      clearAttachments: jest.fn(),
      scrollToBottom: jest.fn(),
      onUsageEvent,
    }));

    await act(async () => {
      await result.current.handleSend('비밀 초안', jest.fn());
    });

    expect(onUsageEvent).toHaveBeenNthCalledWith(1, {
      kind: 'submit',
      draftLength: 5,
    });
    expect(onUsageEvent).toHaveBeenNthCalledWith(2, {
      kind: 'result',
      status: 'ok',
      durationMs: expect.any(Number),
      sessionEventId: 44,
    });
    expect(JSON.stringify(onUsageEvent.mock.calls)).not.toContain('비밀 초안');
  });

  test('입력창을 비워도 submit·result 사용 로그가 원래 compose flow를 유지한다', async () => {
    const api = makeApi();
    const onUsageEvent = jest.fn();
    const { result } = renderHook(() => useChatSendFlow({
      api: api as any,
      sessionId: SID,
      session: makeSession(),
      attachments: [],
      clearAttachments: jest.fn(),
      scrollToBottom: jest.fn(),
      onUsageEvent,
    }));
    const clearComposer = jest.fn();
    await act(async () => {
      await result.current.handleSend('사용 로그 확인', clearComposer, 'compose-original');
    });

    expect(onUsageEvent).toHaveBeenNthCalledWith(1, {
      kind: 'submit',
      draftLength: 8,
      flowId: 'compose-original',
    });
    expect(onUsageEvent).toHaveBeenNthCalledWith(2, {
      kind: 'result',
      status: 'ok',
      durationMs: expect.any(Number),
      flowId: 'compose-original',
    });
  });

  test('빈 입력은 no-op (어떤 호출도 없음)', async () => {
    const api = makeApi();
    const scrollToBottom = jest.fn();
    const clearAttachments = jest.fn();
    const onCleared = jest.fn();
    const { result } = renderHook(() =>
      useChatSendFlow({
        api: api as any,
        sessionId: SID,
        session: makeSession('idle'),
        attachments: [],
        clearAttachments,
        scrollToBottom,
      })
    );
    await act(async () => {
      await result.current.handleSend('   ', onCleared); // trim 결과 빈 문자열
    });
    expect(scrollToBottom).not.toHaveBeenCalled();
    expect(api.intervene).not.toHaveBeenCalled();
    expect(onCleared).not.toHaveBeenCalled();
    expect(clearAttachments).not.toHaveBeenCalled();
    expect(useChatStore.getState().pendingOptimisticBySession[SID]).toBeUndefined();
  });

  test('offline disabled는 이유를 노출하고 초안·첨부를 보존한다', async () => {
    const api = makeApi();
    const scrollToBottom = jest.fn();
    const clearAttachments = jest.fn();
    const onCleared = jest.fn();
    const { result } = renderHook(() => useChatSendFlow({
      api: api as any,
      sessionId: SID,
      session: makeSession('running'),
      attachments: [{ path: '/tmp/offline.png' }],
      clearAttachments,
      scrollToBottom,
      disabled: true,
    }));
    await act(async () => result.current.handleSend('전송 금지', onCleared));
    expect(api.intervene).not.toHaveBeenCalled();
    expect(scrollToBottom).not.toHaveBeenCalled();
    expect(onCleared).not.toHaveBeenCalled();
    expect(clearAttachments).not.toHaveBeenCalled();
    expect(useChatStore.getState().pendingOptimisticBySession[SID]).toBeUndefined();
    expect(result.current.sendError).toBe(
      '노드 연결을 기다리는 동안 메시지와 첨부를 보낼 수 없습니다.',
    );
  });

  test('online render의 기존 handleSend도 offline rerender 뒤에는 no-op이다', async () => {
    const api = makeApi();
    const scrollToBottom = jest.fn();
    const clearAttachments = jest.fn();
    const onCleared = jest.fn();
    const { result, rerender } = renderHook(
      ({ disabled }: { disabled: boolean }) => useChatSendFlow({
        api: api as any,
        sessionId: SID,
        session: makeSession('running'),
        attachments: [],
        clearAttachments,
        scrollToBottom,
        disabled,
      }),
      { initialProps: { disabled: false } },
    );
    const handleFromOnlineRender = result.current.handleSend;
    rerender({ disabled: true });

    await act(async () => handleFromOnlineRender('전송 금지', onCleared));

    expect(api.intervene).not.toHaveBeenCalled();
    expect(scrollToBottom).not.toHaveBeenCalled();
    expect(onCleared).not.toHaveBeenCalled();
    expect(clearAttachments).not.toHaveBeenCalled();
    expect(result.current.sendError).toBe(
      '노드 연결을 기다리는 동안 메시지와 첨부를 보낼 수 없습니다.',
    );
  });

  test('api === null이면 재시도 가능한 이유를 노출하고 초안·첨부를 보존한다', async () => {
    const scrollToBottom = jest.fn();
    const onCleared = jest.fn();
    const clearAttachments = jest.fn();

    const { result } = renderHook(() =>
      useChatSendFlow({
        api: null,
        sessionId: SID,
        session: makeSession(),
        attachments: [{ path: '/tmp/api-not-ready.png' }],
        clearAttachments,
        scrollToBottom,
      })
    );
    await act(async () => {
      await result.current.handleSend('hello', onCleared);
    });
    expect(scrollToBottom).not.toHaveBeenCalled();
    expect(onCleared).not.toHaveBeenCalled();
    expect(clearAttachments).not.toHaveBeenCalled();
    expect(result.current.sendError).toBe(
      '서버 설정을 준비하고 있습니다. 잠시 후 다시 시도해 주세요.',
    );
  });

  test('sessionId === undefined이면 이유를 노출하고 초안·첨부를 보존한다', async () => {
    const scrollToBottom = jest.fn();
    const onCleared = jest.fn();
    const clearAttachments = jest.fn();

    const api = makeApi();
    const { result } = renderHook(() =>
      useChatSendFlow({
        api: api as any,
        sessionId: undefined,
        session: undefined,
        attachments: [{ path: '/tmp/session-missing.png' }],
        clearAttachments,
        scrollToBottom,
      })
    );
    await act(async () => {
      await result.current.handleSend('hello', onCleared);
    });
    expect(api.intervene).not.toHaveBeenCalled();
    expect(scrollToBottom).not.toHaveBeenCalled();
    expect(onCleared).not.toHaveBeenCalled();
    expect(clearAttachments).not.toHaveBeenCalled();
    expect(result.current.sendError).toBe(
      '현재 세션을 확인할 수 없어 메시지를 보낼 수 없습니다.',
    );
  });

  test.each([
    {
      label: '네트워크 오류',
      error: new Error('fetch failed: connection lost'),
      reason: '전달을 확인하지 못했습니다',
    },
    {
      label: 'HTTP detail 오류',
      error: new ApiHttpError(
        '[intervene] HTTP 503 Service Unavailable — {"detail":"세션이 종료되었습니다"}',
        503,
        JSON.stringify({ detail: '세션이 종료되었습니다' }),
      ),
      reason: '전송하지 못했습니다: 세션이 종료되었습니다',
    },
    {
      label: 'HTTP detail 없음',
      error: new ApiHttpError('[intervene] HTTP 409 Conflict', 409, '{}'),
      reason: '전송하지 못했습니다: HTTP 409',
    },
  ])('$label는 입력창 대신 실패 말풍선에 남는다', async ({ error, reason }) => {
    const api = makeApi({ intervene: jest.fn().mockRejectedValue(error) });
    const scrollToBottom = jest.fn();
    const clearAttachments = jest.fn();
    const onCleared = jest.fn();
    const { result } = renderHook(() =>
      useChatSendFlow({
        api: api as any,
        sessionId: SID,
        session: makeSession('idle'),
        attachments: [],
        clearAttachments,
        scrollToBottom,
      })
    );
    await act(async () => {
      await result.current.handleSend('실패할 메시지', onCleared);
    });
    expect(scrollToBottom).toHaveBeenCalledTimes(1);
    expect(onCleared).toHaveBeenCalledTimes(1);
    expect(clearAttachments).toHaveBeenCalledTimes(1);
    const failed = useChatStore.getState().pendingOptimisticBySession[SID] as any;
    expect(failed).toMatchObject({
      pendingStatus: 'failed',
      failureReason: reason,
      originalText: '실패할 메시지',
    });
    expect(result.current.sendError).toBeNull();
    expect(Alert.alert).not.toHaveBeenCalled();
    expect(JSON.stringify(failed)).not.toContain('fetch failed');
    expect(result.current.sending).toBe(false);
  });

  test('delivered 미확인은 실패 말풍선로 바뀌고 전송 전에 비운 입력창을 복원하지 않는다', async () => {
    const api = makeApi({
      intervene: jest.fn().mockResolvedValue({
        delivered: null,
        outcome: 'unknown',
        reason: 'verdict_unknown',
        consumeWhen: null,
      }),
    });
    const scrollToBottom = jest.fn();
    const clearAttachments = jest.fn();
    const onCleared = jest.fn();
    const { result } = renderHook(() =>
      useChatSendFlow({
        api: api as any,
        sessionId: SID,
        session: makeSession('running'),
        attachments: [{ path: '/tmp/a.png' }],
        clearAttachments,
        scrollToBottom,
      })
    );

    await act(async () => {
      await result.current.handleSend('전달 여부가 모를 메시지', onCleared);
    });

    expect(onCleared).toHaveBeenCalledTimes(1);
    expect(clearAttachments).toHaveBeenCalledTimes(1);
    expect((useChatStore.getState().pendingOptimisticBySession[SID] as any)).toMatchObject({
      pendingStatus: 'failed',
      failureReason: '전달을 확인하지 못했습니다',
      originalText: '전달 여부가 모를 메시지',
      attachmentItems: [{ path: '/tmp/a.png' }],
    });
    expect(result.current.sendError).toBeNull();
    expect(Alert.alert).not.toHaveBeenCalled();
    expect(result.current.sending).toBe(false);
  });

  test.each([
    {
      label: 'delivered: true',
      response: { delivered: true, outcome: 'delivered' },
    },
    {
      label: 'delivered: false',
      response: {
        delivered: false,
        outcome: 'queued',
        reason: 'next_turn_required',
        consumeWhen: 'next_turn',
      },
    },
  ])('$label의 기존 성공 cleanup은 유지한다', async ({ response }) => {
    const api = makeApi({
      intervene: jest.fn().mockResolvedValue(response),
    });
    const clearAttachments = jest.fn();
    const onCleared = jest.fn();
    const { result } = renderHook(() =>
      useChatSendFlow({
        api: api as any,
        sessionId: SID,
        session: makeSession('running'),
        attachments: [{ path: '/tmp/a.png' }],
        clearAttachments,
        scrollToBottom: jest.fn(),
      })
    );

    await act(async () => {
      await result.current.handleSend('기존 경로', onCleared);
    });

    expect(onCleared).toHaveBeenCalledTimes(1);
    expect(clearAttachments).toHaveBeenCalledTimes(1);
    expect(useChatStore.getState().pendingOptimisticBySession[SID]).toBeDefined();
    expect(Alert.alert).not.toHaveBeenCalled();
    expect(result.current.sendError).toBeNull();
  });

  test('세션에 pending cell이 있으면 두 번째 송신을 막는다', async () => {
    const api = makeApi();
    const scrollToBottom = jest.fn();
    const clearAttachments = jest.fn();
    const onCleared = jest.fn();
    const { result } = renderHook(() =>
      useChatSendFlow({
        api: api as any,
        sessionId: SID,
        session: makeSession('running'), // 실제 시나리오: 첫 송신 후 status가 running으로 전환된 상태
        attachments: [],
        clearAttachments,
        scrollToBottom,
      })
    );
    await act(async () => {
      await result.current.handleSend('첫 메시지', onCleared);
      await result.current.handleSend('둘째 메시지', onCleared);
    });
    expect(scrollToBottom).toHaveBeenCalledTimes(1);
    expect(api.intervene).toHaveBeenCalledTimes(1);
    expect(onCleared).toHaveBeenCalledTimes(1);
  });

  test('첨부가 있으면 api.intervene에 attachmentPaths 전달', async () => {
    const api = makeApi();
    const scrollToBottom = jest.fn();
    const clearAttachments = jest.fn();
    const onCleared = jest.fn();
    const { result } = renderHook(() =>
      useChatSendFlow({
        api: api as any,
        sessionId: SID,
        session: makeSession('idle'),
        attachments: [{ path: '/tmp/a.png' }, { path: '/tmp/b.pdf' }],
        clearAttachments,
        scrollToBottom,
      })
    );
    await act(async () => {
      await result.current.handleSend('첨부 송신', onCleared);
    });
    expect(api.intervene).toHaveBeenCalledWith(
      SID,
      '첨부 송신\n\n' +
        '[첨부 파일 로컬 경로: /tmp/a.png]\n' +
        '[첨부 파일 로컬 경로: /tmp/b.pdf]',
      ['/tmp/a.png', '/tmp/b.pdf']
    );
    expect(scrollToBottom).toHaveBeenCalledTimes(1);
  });

  test('session.status === "running"이면 optimistic variant=intervention_sent (서버 분기 거울)', async () => {
    const api = makeApi();
    const scrollToBottom = jest.fn();
    const { result } = renderHook(() =>
      useChatSendFlow({
        api: api as any,
        sessionId: SID,
        session: makeSession('running'),
        attachments: [],
        clearAttachments: jest.fn(),
        scrollToBottom,
      })
    );
    await act(async () => {
      await result.current.handleSend('송신', jest.fn());
    });
    const slot = useChatStore.getState().pendingOptimisticBySession[SID];
    expect(slot?.type).toBe('intervention_sent');
  });

  test('보내기를 누르면 API 응답 전 입력창과 첨부를 비우고 sending cell을 둔다', async () => {
    const request = deferred<{ delivered: boolean; outcome: string }>();
    const api = makeApi({ intervene: jest.fn(() => request.promise) });
    const onCleared = jest.fn();
    const clearAttachments = jest.fn();
    const { result } = renderHook(() => useChatSendFlow({
      api: api as any,
      sessionId: SID,
      session: makeSession(),
      attachments: [{ path: '/tmp/a.png', name: 'a.png' }],
      clearAttachments,
      scrollToBottom: jest.fn(),
    }));
    let pendingRequest!: Promise<void>;

    await act(async () => {
      pendingRequest = result.current.handleSend('  보낼 문장  ', onCleared);
    });

    expect(onCleared).toHaveBeenCalledTimes(1);
    expect(clearAttachments).toHaveBeenCalledTimes(1);
    expect(api.intervene).toHaveBeenCalledWith(
      SID,
      '보낼 문장\n\n[첨부 파일 로컬 경로: /tmp/a.png]',
      ['/tmp/a.png'],
    );
    expect(result.current.sending).toBe(true);
    expect(useChatStore.getState().pendingOptimisticBySession[SID]).toMatchObject({
      pendingStatus: 'sending',
      originalText: '  보낼 문장  ',
      attachmentItems: [{ path: '/tmp/a.png', name: 'a.png' }],
    });

    await act(async () => {
      request.resolve({ delivered: true, outcome: 'delivered' });
      await pendingRequest;
    });
    expect(result.current.sending).toBe(true);
  });

  test('실패 뒤 같은 문장의 서버 이벤트가 오면 failed cell도 정식 이벤트로 정리된다', async () => {
    const api = makeApi({ intervene: jest.fn().mockRejectedValue(new Error('network down')) });
    const { result } = renderHook(() => useChatSendFlow({
      api: api as any,
      sessionId: SID,
      session: makeSession(),
      attachments: [],
      clearAttachments: jest.fn(),
      scrollToBottom: jest.fn(),
    }));
    await act(async () => result.current.handleSend('전달된 문장', jest.fn()));
    expect((useChatStore.getState().pendingOptimisticBySession[SID] as any).pendingStatus).toBe('failed');

    act(() => useChatStore.getState().mergeEvents(SID, [
      { id: '501', type: 'user_message', data: { text: '전달된 문장' } },
    ]));

    expect(useChatStore.getState().pendingOptimisticBySession[SID]).toBeUndefined();
    expect(useChatStore.getState().eventsBySession[SID]).toContainEqual({
      id: '501',
      type: 'user_message',
      data: { text: '전달된 문장' },
    });
  });

  test('서버 이벤트가 먼저 도착한 뒤 HTTP 실패하면 실패 표시를 다시 만들지 않는다', async () => {
    const request = deferred<never>();
    const api = makeApi({ intervene: jest.fn(() => request.promise) });
    const onCleared = jest.fn();
    const { result } = renderHook(() => useChatSendFlow({
      api: api as any,
      sessionId: SID,
      session: makeSession(),
      attachments: [],
      clearAttachments: jest.fn(),
      scrollToBottom: jest.fn(),
    }));
    let pendingRequest!: Promise<void>;
    await act(async () => { pendingRequest = result.current.handleSend('한 번만 보일 문장', onCleared); });
    act(() => useChatStore.getState().mergeEvents(SID, [
      { id: '502', type: 'user_message', data: { text: '한 번만 보일 문장' } },
    ]));
    await act(async () => {
      request.reject(new Error('fetch failed: connection lost'));
      await pendingRequest;
    });

    expect(useChatStore.getState().pendingOptimisticBySession[SID]).toBeUndefined();
    expect(useChatStore.getState().eventsBySession[SID]).toHaveLength(1);
    expect(result.current.sendError).toBeNull();
    expect(Alert.alert).not.toHaveBeenCalled();
    expect(onCleared).toHaveBeenCalledTimes(1);
  });

  test('재전송은 같은 문장·첨부로 보내고 입력창 복원은 초안을 앞에 합친다', async () => {
    const onUsageEvent = jest.fn();
    const api = makeApi({
      intervene: jest.fn()
        .mockRejectedValueOnce(new Error('first request lost'))
        .mockRejectedValueOnce(new Error('retry request lost')),
    });
    const { result } = renderHook(() => useChatSendFlow({
      api: api as any,
      sessionId: SID,
      session: makeSession(),
      attachments: [{ path: '/tmp/a.png', name: 'photo.png' }],
      clearAttachments: jest.fn(),
      scrollToBottom: jest.fn(),
      onUsageEvent,
    }));
    await act(async () => result.current.handleSend('실패한 초안', jest.fn(), 'compose-retry'));
    const failed = useChatStore.getState().pendingOptimisticBySession[SID] as any;
    await act(async () => result.current.retryPendingOptimistic(failed.id));

    expect(api.intervene).toHaveBeenNthCalledWith(
      2,
      SID,
      '실패한 초안\n\n[첨부 파일 로컬 경로: /tmp/a.png]',
      ['/tmp/a.png'],
    );
    expect((useChatStore.getState().pendingOptimisticBySession[SID] as any).usageFlowId).toBe('compose-retry');
    expect((useChatStore.getState().pendingOptimisticBySession[SID] as any).pendingStatus).toBe('failed');
    expect(onUsageEvent.mock.calls.map(([event]) => event.flowId)).toEqual([
      'compose-retry',
      'compose-retry',
      'compose-retry',
      'compose-retry',
    ]);
    let restored: ReturnType<typeof result.current.restorePendingOptimistic> = undefined;
    act(() => {
      restored = result.current.restorePendingOptimistic(failed.id, '새로 입력한 글');
    });
    expect(restored).toEqual({
      inputText: '실패한 초안\n\n새로 입력한 글',
      attachments: [{ path: '/tmp/a.png', name: 'photo.png' }],
    });
    expect(useChatStore.getState().pendingOptimisticBySession[SID]).toBeUndefined();
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test('optimistic chat clearing keeps the persisted text until confirmation and preserves later typing', async () => {
  await useAuthStore.persist.rehydrate(); await useSettingsStore.persist.rehydrate(); await useDraftStore.persist.rehydrate();
  useAuthStore.setState({ jwt: `header.${Buffer.from(JSON.stringify({ email: 'chat@example.com' })).toString('base64url')}.signature` });
  useSettingsStore.setState({ serverUrl: 'https://chat.example' });
  useDraftStore.setState({ drafts: {} }); reset();
  let confirm!: (value: unknown) => void;
  const api = makeApi({ intervene: jest.fn(() => new Promise(resolve => { confirm = resolve; })) });
  const hook = renderHook(() => {
    const draft = usePersistentDraft('chat', ['node-1', SID], '');
    return { draft, send: useChatSendFlow({ api: api as any, sessionId: SID, session: makeSession(), attachments: [],
      clearAttachments: jest.fn(), scrollToBottom: jest.fn(), onSendConfirmed: draft.clearIfMatches }) };
  });
  act(() => hook.result.current.draft.setValue('전송할 원문'));
  const clearVisible = jest.fn(); let sending!: Promise<void>;
  act(() => { sending = hook.result.current.send.handleSend('전송할 원문', clearVisible); });
  expect(clearVisible).toHaveBeenCalled();
  expect(hook.result.current.draft.value).toBe('전송할 원문');
  act(() => hook.result.current.draft.setValue('새 입력'));
  await act(async () => { confirm({ delivered: true, outcome: 'delivered' }); await sending; });
  expect(hook.result.current.draft.value).toBe('새 입력');
  act(() => reset());
});
