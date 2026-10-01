import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import type { Session } from '../../../api/types';
import { useSessionStore } from '../../../store/sessionStore';
import { useNodeConnectivityStore } from '../../../store/nodeConnectivityStore';

const mockUsePlannerFolderRuns = jest.fn();

jest.mock('../../../hooks/usePlannerReads', () => ({
  usePlannerFolderSessions: (...args: unknown[]) => mockUsePlannerFolderRuns(...args),
}));
jest.mock('../../useSessionCardAnimation', () => ({
  useSessionCardAnimation: () => {
    const { Animated } = require('react-native');
    return {
      pulse: new Animated.Value(0),
      shimmer: new Animated.Value(0),
      reducedMotion: true,
      appActive: true,
      animationEnabled: false,
    };
  },
}));

import { FolderSessionHistory } from '../FolderSessionHistory';

beforeEach(() => {
  useNodeConnectivityStore.getState().reset();
  mockUsePlannerFolderRuns.mockReturnValue({
    data: {
      items: [
        { agentSessionId: 'display-session' },
        { agentSessionId: 'preview-session' },
        { agentSessionId: 'planner-session' },
        { agentSessionId: 'partial-session' },
      ],
      nextCursor: null,
      total: 4,
    },
    loading: false,
    error: null,
    loadMore: jest.fn(),
  });
  useSessionStore.setState({
    sessions: {
      'display-session': {
        agentSessionId: 'display-session',
        displayName: '표시 이름',
        agentName: '로젤린',
        nodeId: 'eiaserinnys',
        status: 'running',
        createdAt: '2026-07-18T00:00:00.000Z',
        updatedAt: '2026-07-18T00:01:00.000Z',
      } as Session,
      'preview-session': {
        agentSessionId: 'preview-session',
        displayName: null,
        lastMessage: { preview: '마지막 메시지 첫 줄\n둘째 줄' },
      } as Session,
      'partial-session': {
        agentSessionId: 'partial-session',
        displayName: null,
      } as Session,
    },
  });
});

test('offline running row만 숨기고 source를 보존하며 reconnect에 즉시 복구한다', () => {
  mockUsePlannerFolderRuns.mockReturnValue({
    data: { items: [{ agentSessionId: 'display-session' }], nextCursor: null, total: 1 },
    loading: false,
    error: null,
    loadMore: jest.fn(),
  });
  useNodeConnectivityStore.getState().applySnapshot([{ nodeId: 'another-node' }]);
  const screen = render(<FolderSessionHistory api={null} folderId="task-1" />);

  expect(screen.queryByTestId('task-run-row-display-session')).toBeNull();
  expect(useSessionStore.getState().sessions['display-session']).toBeDefined();

  act(() => useNodeConnectivityStore.getState().upsert({ nodeId: 'eiaserinnys' }));
  expect(screen.getByTestId('task-run-row-display-session')).toBeTruthy();
});

test('실행 이력은 UUID 대신 카탈로그 이름·마지막 메시지·플래너 이름 순으로 표시한다', () => {
  const screen = render(
    <FolderSessionHistory
      api={null}
      folderId="task-1"
      sessionSummaries={[{
        agentSessionId: 'planner-session',
        displayName: '플래너 세션 이름',
      } as never, {
        agentSessionId: 'partial-session',
        displayName: '부분 카탈로그 보완 이름',
      } as never]}
    />,
  );

  expect(screen.getByText('표시 이름')).toBeTruthy();
  expect(screen.getByText('마지막 메시지 첫 줄')).toBeTruthy();
  expect(screen.getByText('플래너 세션 이름')).toBeTruthy();
  expect(screen.getByText('부분 카탈로그 보완 이름')).toBeTruthy();
  expect(screen.queryByText('display-session')).toBeNull();
});

test('세션 카드 컴포넌트는 상위 섹션 제목을 중복 렌더하지 않는다', () => {
  const screen = render(<FolderSessionHistory api={null} folderId="task-1" />);
  expect(screen.queryByText('실행 이력')).toBeNull();
  expect(screen.getAllByTestId('session-card-title-row')).toHaveLength(4);
  expect(screen.getAllByTestId('session-card-identity-row')).toHaveLength(4);
  expect(screen.getAllByTestId('session-card-context-row')).toHaveLength(4);
});

test('task run 페이지에 아직 없는 hydrate projection 세션도 누락하지 않는다', () => {
  mockUsePlannerFolderRuns.mockReturnValue({
    data: { items: [], nextCursor: null, total: 0 },
    loading: false,
    error: null,
    loadMore: jest.fn(),
  });
  const screen = render(
    <FolderSessionHistory
      api={null}
      folderId="task-1"
      sessionSummaries={[{
        agentSessionId: 'projection-only',
        displayName: 'projection 세션',
        status: 'completed',
        createdAt: '2026-07-18T00:00:00Z',
        updatedAt: '2026-07-18T00:00:00Z',
      } as never]}
    />,
  );

  expect(screen.getByTestId('task-run-row-projection-only')).toBeTruthy();
});

test('catalog caller 관계는 같은 SessionCard를 depth indentation으로 렌더한다', () => {
  mockUsePlannerFolderRuns.mockReturnValue({
    data: {
      items: [{ agentSessionId: 'parent' }, { agentSessionId: 'child' }],
      nextCursor: null,
      total: 2,
    },
    loading: false,
    error: null,
    loadMore: jest.fn(),
  });
  useSessionStore.setState({
    sessions: {
      parent: {
        agentSessionId: 'parent', displayName: '부모', status: 'completed',
        createdAt: '2026-07-18T00:00:00Z', updatedAt: '2026-07-18T00:00:00Z',
      } as Session,
      child: {
        agentSessionId: 'child', displayName: '자식', status: 'completed',
        callerSessionId: 'parent',
        createdAt: '2026-07-18T01:00:00Z', updatedAt: '2026-07-18T01:00:00Z',
      } as Session,
    },
  });
  const screen = render(
    <FolderSessionHistory
      api={null}
      folderId="task-1"
      sessionSummaries={[{
        agentSessionId: 'parent',
        displayName: '부모',
        createdAt: '2026-07-18T00:00:00Z',
        updatedAt: '2026-07-18T00:00:00Z',
      } as never, {
        agentSessionId: 'child',
        displayName: '자식',
        createdAt: '2026-07-18T01:00:00Z',
        updatedAt: '2026-07-18T01:00:00Z',
      } as never]}
    />,
  );

  expect(screen.getByTestId('task-run-row-parent')).toBeTruthy();
  expect(screen.getByTestId('task-run-row-child')).toBeTruthy();
  expect(StyleSheet.flatten(screen.getByTestId('task-run-depth-parent').props.style).marginLeft).toBe(0);
  expect(StyleSheet.flatten(screen.getByTestId('task-run-depth-child').props.style).marginLeft).toBe(16);
});

test('hydrate된 업무 projection의 caller 관계도 catalog 도착 전 즉시 트리로 렌더한다', () => {
  mockUsePlannerFolderRuns.mockReturnValue({
    data: {
      items: [{ agentSessionId: 'parent' }, { agentSessionId: 'child' }],
      nextCursor: null,
      total: 2,
    },
    loading: false,
    error: null,
    loadMore: jest.fn(),
  });
  useSessionStore.setState({ sessions: {} });

  const screen = render(
    <FolderSessionHistory
      api={null}
      folderId="task-1"
      sessionSummaries={[{
        agentSessionId: 'parent',
        displayName: '부모',
        status: 'completed',
        createdAt: '2026-07-18T00:00:00Z',
        updatedAt: '2026-07-18T00:00:00Z',
      } as never, {
        agentSessionId: 'child',
        displayName: '자식',
        status: 'completed',
        callerSessionId: 'parent',
        createdAt: '2026-07-18T01:00:00Z',
        updatedAt: '2026-07-18T01:00:00Z',
      } as never]}
    />,
  );

  expect(StyleSheet.flatten(screen.getByTestId('task-run-depth-child').props.style).marginLeft).toBe(16);
});

test('cache miss 실행 세션은 기존 targeted GET으로 hydrate한 뒤 caller 트리를 복원한다', async () => {
  mockUsePlannerFolderRuns.mockReturnValue({
    data: {
      items: [{ agentSessionId: 'parent' }, { agentSessionId: 'child' }],
      nextCursor: null,
      total: 2,
    },
    loading: false,
    error: null,
    loadMore: jest.fn(),
  });
  useSessionStore.setState({ sessions: {} });
  const api = {
    getSessionsByIds: jest.fn(async () => [{
      agentSessionId: 'parent', displayName: '부모', status: 'completed',
      createdAt: '2026-07-18T00:00:00Z', updatedAt: '2026-07-18T00:00:00Z',
    }, {
      agentSessionId: 'child', displayName: '자식', status: 'completed',
      callerSessionId: 'parent',
      createdAt: '2026-07-18T01:00:00Z', updatedAt: '2026-07-18T01:00:00Z',
    }] as Session[]),
  };

  const screen = render(
    <FolderSessionHistory api={api as never} folderId="task-1" />,
  );

  await waitFor(() => expect(api.getSessionsByIds).toHaveBeenCalledWith(['parent', 'child']));
  await waitFor(() => expect(
    StyleSheet.flatten(screen.getByTestId('task-run-depth-child').props.style).marginLeft,
  ).toBe(16));
  expect(useSessionStore.getState().sessions.parent?.agentSessionId).toBe('parent');
  expect(useSessionStore.getState().sessions.child?.agentSessionId).toBe('child');
});

test('응답 ID가 일치해도 store에 남지 않으면 로딩 대신 재시도를 표시한다', async () => {
  mockUsePlannerFolderRuns.mockReturnValue({
    data: { items: [{ agentSessionId: 'cold-session' }], nextCursor: null, total: 1 },
    loading: false, error: null, loadMore: jest.fn(),
  });
  useSessionStore.setState({ sessions: {} });
  const merge = jest.spyOn(useSessionStore.getState(), 'mergeSessions').mockImplementation(() => undefined);
  const api = { getSessionsByIds: jest.fn(async () => [{
    agentSessionId: 'cold-session', displayName: '복원된 세션', status: 'completed',
    createdAt: '2026-07-18T00:00:00Z', updatedAt: '2026-07-18T02:00:00Z',
  }] as Session[]) };
  try {
    const screen = render(<FolderSessionHistory api={api as never} folderId="task-1" />);
    await waitFor(() => expect(screen.getByTestId('task-run-detail-error-cold-session')).toBeTruthy());
    expect(screen.queryByTestId('task-run-detail-loading-cold-session')).toBeNull();
  } finally {
    merge.mockRestore();
  }
});

test('세션 상세 GET 실패는 가짜 idle SessionCard 대신 오류와 재시도를 보존한다', async () => {
  mockUsePlannerFolderRuns.mockReturnValue({
    data: { items: [{ agentSessionId: 'cold-session' }], nextCursor: null, total: 1 },
    loading: false,
    error: null,
    loadMore: jest.fn(),
  });
  useSessionStore.setState({ sessions: {} });
  const hydrated = {
    agentSessionId: 'cold-session', displayName: '복원된 세션', status: 'completed',
    createdAt: '2026-07-18T00:00:00Z', updatedAt: '2026-07-18T02:00:00Z',
  } as Session;
  const api = {
    getSessionsByIds: jest.fn()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce([hydrated]),
  };
  const screen = render(
    <FolderSessionHistory
      api={api as never}
      folderId="task-1"
      sessionSummaries={[{
        agentSessionId: 'cold-session',
        displayName: '부분 세션',
        createdAt: '2026-07-18T00:00:00Z',
        updatedAt: '2026-07-18T01:00:00Z',
      } as never]}
    />,
  );

  expect(screen.getByTestId('task-run-detail-loading-cold-session')).toBeTruthy();
  await waitFor(() => expect(
    screen.getByTestId('task-run-detail-error-cold-session'),
  ).toBeTruthy());
  expect(screen.queryByTestId('task-run-row-cold-session')).toBeNull();
  expect(screen.queryByText('대기 중')).toBeNull();

  fireEvent.press(screen.getByTestId('task-run-detail-retry-cold-session'));
  await waitFor(() => expect(api.getSessionsByIds).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.getByTestId('task-run-row-cold-session')).toBeTruthy());
  expect(screen.getByText('복원된 세션')).toBeTruthy();
});

test('실행 이력 기본 표면에 아바타·상태·시간·에이전트·노드를 조밀하게 복원한다', () => {
  const screen = render(<FolderSessionHistory api={null} folderId="task-1" />);

  expect(screen.getByTestId('task-run-avatar-display-session')).toBeTruthy();
  expect(screen.getByText('실행 중')).toBeTruthy();
  expect(screen.getByText('로젤린')).toBeTruthy();
  expect(screen.getByText('eiaserinnys')).toBeTruthy();
  expect(screen.getByTestId('task-run-time-display-session')).toBeTruthy();
  const rowStyle = StyleSheet.flatten(
    screen.getByTestId('task-run-row-display-session').props.style,
  );
  expect(rowStyle.minHeight).toBe(112);
  expect(rowStyle.paddingVertical).toBe(16);
});
