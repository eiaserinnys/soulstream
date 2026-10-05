import React from 'react';
import { Alert, Animated } from 'react-native';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import type { Session } from '../../api/types';
import { SessionCardById } from '../SessionCardById';
import { useSessionStore } from '../../store/sessionStore';
import { useSettingsStore } from '../../store/settingsStore';
import { usePlannerStore } from '../../store/plannerStore';
import { useAppNoticeStore } from '../../store/appNoticeStore';
import type { PlannerFolder } from '../../api/plannerTypes';

jest.spyOn(Animated, 'loop').mockImplementation(() => ({
  start: jest.fn(),
  stop: jest.fn(),
  reset: jest.fn(),
} as any));

function session(overrides: Partial<Session> = {}): Session {
  return {
    agentSessionId: 'sess/review',
    displayName: '검수할 세션',
    status: 'completed',
    createdAt: '2026-07-13T00:00:00Z',
    updatedAt: '2026-07-13T00:00:00Z',
    reviewRequired: true,
    reviewState: 'needs_review',
    ...overrides,
  };
}

function response(body: unknown, status = 200): Partial<Response> {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Conflict',
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: new Headers({ 'Content-Type': 'application/json' }),
  };
}

beforeEach(() => {
  useSettingsStore.setState({ serverUrl: 'https://server.test' });
  useAppNoticeStore.setState({ notice: null });
  useSessionStore.getState().setSessions([session()]);
  usePlannerStore.getState().resetForTest();
  const plannerFolder = {
    page: {
      id: 'task-1', title: '업무', dailyDate: null, version: 1, archived: false,
      metadata: {}, createdAt: '', updatedAt: '',
    },
    blocks: [], folderId: 'task-1', folderSummary: null, status: 'review', assignee: '',
    contextCount: 0, progress: null, projectPageId: null,
    sessions: [{
      agentSessionId: 'sess/review', folderId: null, displayName: '검수할 세션',
      nodeId: null, sessionType: null, status: 'completed', agentId: null,
      predecessorSessionId: null, reviewState: 'needs_review', createdAt: '', updatedAt: '',
    }],
    sessionIds: ['sess/review'],
  } as PlannerFolder;
  usePlannerStore.setState({ selectedFolderSnapshot: plannerFolder });
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('SessionCard review acknowledge', () => {
  it('캐시 세션의 folderId로 폴더 이름을 그리고 명시 null 배정은 미분류로 둔다', () => {
    const row = session({ folderId: 'folder-1' });
    useSessionStore.getState().setSessions([row]);
    useSessionStore.setState({
      catalog: {
        folders: [{ id: 'folder-1', name: '작업 폴더', sortOrder: 0 }],
        sessions: {},
      },
    });
    const view = render(<SessionCardById sessionId="sess/review" onPress={jest.fn()} />);
    expect(view.getByText('작업 폴더')).toBeTruthy();

    act(() => {
      useSessionStore.setState({
        catalog: {
          folders: [{ id: 'folder-1', name: '작업 폴더', sortOrder: 0 }],
          sessions: { 'sess/review': { folderId: null, displayName: null } },
        },
      });
    });
    expect(view.queryByText('작업 폴더')).toBeNull();
  });

  it('needs_review는 완료 badge와 중복 없이 식별 가능한 액션 하나만 표시한다', async () => {
    const { findByText, queryByText, queryByTestId } = render(
      <SessionCardById sessionId="sess/review" onPress={jest.fn()} />,
    );

    expect(await findByText('검수 필요')).toBeTruthy();
    expect(queryByText('완료')).toBeNull();
    expect(queryByTestId('session-card-review-ack')).not.toBeNull();

    act(() => {
      useSessionStore.getState().setSessions([
        session({ reviewRequired: false, reviewState: 'not_required' }),
      ]);
    });
    await waitFor(() => {
      expect(queryByTestId('session-card-review-ack')).toBeNull();
    });
  });

  it('부분 delta에서 reviewRequired가 빠져도 needs_review 상태를 표시한다', async () => {
    useSessionStore.getState().setSessions([
      session({ status: 'unknown', reviewRequired: false }),
    ]);

    const { findByText, queryByTestId } = render(
      <SessionCardById sessionId="sess/review" onPress={jest.fn()} />,
    );

    expect(await findByText('검수 필요')).toBeTruthy();
    expect(queryByTestId('session-card-review-ack')).not.toBeNull();
  });

  it.each([
    [true, '확인 처리했습니다.'],
    [false, '이미 확인된 결과입니다.'],
  ] as const)('ACK changed=%s 성공은 cache를 acknowledged로 바꾸고 결과를 알린다', async (changed, message) => {
    const fetchMock = jest.fn().mockResolvedValue(
      response({
        status: 'ok',
        agentSessionId: 'sess/review',
        reviewState: 'acknowledged',
        changed,
      }),
    );
    (global as any).fetch = fetchMock;
    const openSession = jest.fn();
    const { findByTestId, queryByTestId } = render(
      <SessionCardById sessionId="sess/review" onPress={openSession} />,
    );

    fireEvent.press(await findByTestId('session-card-review-ack'), {
      stopPropagation: jest.fn(),
    });

    await waitFor(() => {
      expect(useSessionStore.getState().sessions['sess/review'].reviewState).toBe(
        'acknowledged',
      );
      expect(queryByTestId('session-card-review-ack')).toBeNull();
      expect(
        usePlannerStore.getState().selectedFolderSnapshot?.sessions[0].reviewState,
      ).toBe('acknowledged');
    });
    expect(openSession).not.toHaveBeenCalled();
    expect(useAppNoticeStore.getState().notice).toMatchObject({
      title: '검수 확인',
      message,
      tone: 'success',
    });
    expect(Alert.alert).not.toHaveBeenCalled();
  });

  it('네트워크 실패는 별도로 알리고 검수 표시를 유지한다', async () => {
    (global as any).fetch = jest
      .fn()
      .mockRejectedValue(new TypeError('Network request failed'));
    const { findByTestId, queryByTestId } = render(
      <SessionCardById sessionId="sess/review" onPress={jest.fn()} />,
    );

    fireEvent.press(await findByTestId('session-card-review-ack'), {
      stopPropagation: jest.fn(),
    });

    await waitFor(() => {
      expect(useAppNoticeStore.getState().notice).toMatchObject({
        title: '네트워크 오류',
        message: '연결을 확인하고 다시 시도해주세요.',
        tone: 'error',
      });
    });
    expect(Alert.alert).not.toHaveBeenCalled();
    expect(queryByTestId('session-card-review-ack')).not.toBeNull();
    expect(useSessionStore.getState().sessions['sess/review'].reviewState).toBe(
      'needs_review',
    );
  });

  it('서버 오류는 코드와 메시지를 알리고 검수 표시를 유지한다', async () => {
    (global as any).fetch = jest.fn().mockResolvedValue(
      response(
        { error: { code: 'REVIEW_NOT_PENDING', message: 'no pending review' } },
        409,
      ),
    );
    const { findByTestId, queryByTestId } = render(
      <SessionCardById sessionId="sess/review" onPress={jest.fn()} />,
    );

    fireEvent.press(await findByTestId('session-card-review-ack'), {
      stopPropagation: jest.fn(),
    });

    await waitFor(() => {
      expect(useAppNoticeStore.getState().notice).toMatchObject({
        title: '검수 확인 실패',
        message: 'REVIEW_NOT_PENDING: no pending review',
        tone: 'error',
      });
    });
    expect(Alert.alert).not.toHaveBeenCalled();
    expect(queryByTestId('session-card-review-ack')).not.toBeNull();
    expect(useSessionStore.getState().sessions['sess/review'].reviewState).toBe(
      'needs_review',
    );
  });

  it('요청 중에는 중복 탭을 막는다', async () => {
    let resolveRequest!: (value: Partial<Response>) => void;
    const fetchMock = jest.fn(
      () => new Promise<Partial<Response>>((resolve) => {
        resolveRequest = resolve;
      }),
    );
    (global as any).fetch = fetchMock;
    const { findByTestId } = render(
      <SessionCardById sessionId="sess/review" onPress={jest.fn()} />,
    );
    const button = await findByTestId('session-card-review-ack');

    fireEvent.press(button, { stopPropagation: jest.fn() });
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.press(button, { stopPropagation: jest.fn() });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveRequest(
      response({
        status: 'ok',
        agentSessionId: 'sess/review',
        reviewState: 'acknowledged',
        changed: true,
      }),
    );
    await waitFor(() => {
      expect(useSessionStore.getState().sessions['sess/review'].reviewState).toBe(
        'acknowledged',
      );
    });
  });
});
