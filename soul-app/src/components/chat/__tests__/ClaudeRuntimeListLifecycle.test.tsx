import React from 'react';
import { Alert } from 'react-native';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import type { ApiClient } from '../../../api/client';
import type {
  ClaudeRuntimeSchedulesResponse,
  ClaudeRuntimeTasksResponse,
} from '../../../api/types';
import { useAuthStore } from '../../../store/authStore';
import { useChatStore } from '../../../store/chatStore';
import { useClaudeRuntimeListLifecycleStore } from '../../../store/claudeRuntimeListLifecycleStore';
import { SessionSuccessionHost } from '../../planner/SessionSuccessionHost';
import { ClaudeRuntimeSchedulesStrip } from '../ClaudeRuntimeSchedulesStrip';
import { ClaudeRuntimeTasksStrip } from '../ClaudeRuntimeTasksStrip';

jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
jest.mock('../../planner/SessionSuccessionSheet', () => {
  const ReactModule = require('react');
  const { TouchableOpacity: MockTouchableOpacity } = require('react-native');
  return {
    SessionSuccessionSheet: ({ onCreated }: { onCreated(sessionId: string): void }) => (
      ReactModule.createElement(MockTouchableOpacity, {
        testID: 'complete-session-creation',
        onPress: () => onCreated('session-new'),
      })
    ),
  };
});

function apiWithLists({
  tasks,
  schedules,
}: {
  tasks: jest.Mock;
  schedules: jest.Mock;
}): ApiClient {
  return {
    listClaudeBackgroundTasks: tasks,
    listClaudeSchedules: schedules,
  } as unknown as ApiClient;
}

function tasksResponse(
  sessionId: string,
  taskId = 'snapshot-task',
): ClaudeRuntimeTasksResponse {
  return {
    sessionId,
    sessionState: 'running',
    runtimeSessionId: `runtime-${sessionId}`,
    updatedAt: 10,
    tasks: [{ taskId, status: 'running', updatedAt: 10 }],
    notifications: [],
    remoteTriggers: [],
  };
}

function schedulesResponse(
  sessionId: string,
  scheduleId = 'snapshot-schedule',
): ClaudeRuntimeSchedulesResponse {
  return {
    sessionId,
    nextRunAt: '2026-09-08T00:00:00.000Z',
    schedules: [{
      scheduleId,
      sessionId,
      kind: 'wakeup',
      status: 'active',
      nextRunAt: '2026-09-08T00:00:00.000Z',
    }],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  jest.restoreAllMocks();
  useAuthStore.setState({ jwt: null });
  useChatStore.setState({ claudeRuntimeBySession: {} });
  useClaudeRuntimeListLifecycleStore.setState({
    initialRefreshSuppressionBySession: {},
    revisionCounter: 0,
    revisionsBySession: {},
    scheduleChangesBySession: {},
  });
});

test('Host가 막 생성한 세션은 tasks와 schedules 초기 복구 GET을 모두 생략한다', async () => {
  const onCreated = jest.fn();
  const host = render(
    <SessionSuccessionHost
      api={null}
      request={{} as any}
      onClose={jest.fn()}
      onCreated={onCreated}
    />,
  );
  fireEvent.press(host.getByTestId('complete-session-creation'));
  expect(onCreated).toHaveBeenCalledWith('session-new');

  const listTasks = jest.fn().mockResolvedValue(tasksResponse('session-new'));
  const listSchedules = jest.fn().mockResolvedValue(schedulesResponse('session-new'));
  const api = apiWithLists({ tasks: listTasks, schedules: listSchedules });
  render(
    <>
      <ClaudeRuntimeTasksStrip sessionId="session-new" api={api} />
      <ClaudeRuntimeSchedulesStrip sessionId="session-new" api={api} />
    </>,
  );
  await act(async () => { await Promise.resolve(); });

  expect(listTasks).not.toHaveBeenCalled();
  expect(listSchedules).not.toHaveBeenCalled();
});

test('기존 세션 재입장은 tasks와 schedules snapshot을 복구하고 이후 SSE를 반영한다', async () => {
  const sessionId = 'session-existing';
  const listTasks = jest.fn().mockResolvedValue(tasksResponse(sessionId));
  const listSchedules = jest.fn().mockResolvedValue(schedulesResponse(sessionId));
  const api = apiWithLists({ tasks: listTasks, schedules: listSchedules });

  render(
    <>
      <ClaudeRuntimeTasksStrip sessionId={sessionId} api={api} />
      <ClaudeRuntimeSchedulesStrip sessionId={sessionId} api={api} />
    </>,
  );

  await waitFor(() => {
    expect(listTasks).toHaveBeenCalledTimes(1);
    expect(listSchedules).toHaveBeenCalledTimes(1);
    expect(useChatStore.getState().claudeRuntimeBySession[sessionId]).toMatchObject({
      tasks: { 'snapshot-task': { taskId: 'snapshot-task' } },
      schedules: { 'snapshot-schedule': { scheduleId: 'snapshot-schedule' } },
    });
  });

  act(() => {
    useChatStore.getState().applyClaudeRuntimeEvent(
      sessionId,
      'claude_runtime_task_started',
      { task_id: 'live-task', status: 'running', timestamp: 20 },
    );
    useChatStore.getState().applyClaudeRuntimeEvent(
      sessionId,
      'claude_runtime_schedule_updated',
      {
        schedule_id: 'live-schedule',
        schedule_kind: 'wakeup',
        status: 'active',
        next_run_at: '2026-09-07T23:00:00.000Z',
        timestamp: 21,
      },
    );
  });

  expect(useChatStore.getState().claudeRuntimeBySession[sessionId]).toMatchObject({
    tasks: { 'live-task': { taskId: 'live-task' } },
    schedules: { 'live-schedule': { scheduleId: 'live-schedule' } },
  });
});

test('자동 조회 실패는 팝업을 띄우지 않고 사용자가 누른 tasks 새로고침 실패만 알린다', async () => {
  const sessionId = 'session-manual-task-refresh';
  useChatStore.getState().setClaudeRuntimeTasks(sessionId, tasksResponse(sessionId, 'visible-task'));
  const listTasks = jest.fn().mockRejectedValue(new Error('CONTROL_RESULT_TIMEOUT'));
  const api = apiWithLists({ tasks: listTasks, schedules: jest.fn() });
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  const screen = render(<ClaudeRuntimeTasksStrip sessionId={sessionId} api={api} />);

  await waitFor(() => expect(listTasks).toHaveBeenCalledTimes(1));
  expect(alert).not.toHaveBeenCalled();
  expect(useChatStore.getState().claudeRuntimeBySession[sessionId].tasks)
    .toHaveProperty('visible-task');
  expect(screen.getByText('목록 미확인')).toBeTruthy();
  expect(screen.getByText('1')).toBeTruthy();

  fireEvent.press(screen.getByTestId('runtime-tasks-refresh-touch'));
  await waitFor(() => expect(listTasks).toHaveBeenCalledTimes(2));
  expect(alert).toHaveBeenCalledTimes(1);
  expect(alert).toHaveBeenCalledWith('조회 실패', 'CONTROL_RESULT_TIMEOUT');
});

test('사용자가 누른 schedules 새로고침 실패는 계속 알린다', async () => {
  const sessionId = 'session-manual-schedule-refresh';
  useChatStore.getState().setClaudeRuntimeSchedules(
    sessionId,
    schedulesResponse(sessionId, 'visible-schedule'),
  );
  const listSchedules = jest.fn().mockRejectedValue(new Error('CONTROL_RESULT_TIMEOUT'));
  const api = apiWithLists({ tasks: jest.fn(), schedules: listSchedules });
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  const screen = render(<ClaudeRuntimeSchedulesStrip sessionId={sessionId} api={api} />);

  await waitFor(() => expect(listSchedules).toHaveBeenCalledTimes(1));
  expect(alert).not.toHaveBeenCalled();

  fireEvent.press(screen.getByLabelText('예약 새로고침'));
  await waitFor(() => expect(listSchedules).toHaveBeenCalledTimes(2));
  expect(alert).toHaveBeenCalledTimes(1);
  expect(alert).toHaveBeenCalledWith('예약 조회 실패', 'CONTROL_RESULT_TIMEOUT');
});

test('빈 기존 세션의 자동 snapshot 실패는 두 strip의 수동 재조회 경로를 남긴다', async () => {
  const sessionId = 'session-empty-recovery';
  const listTasks = jest.fn()
    .mockRejectedValueOnce(new Error('task snapshot timeout'))
    .mockResolvedValueOnce(tasksResponse(sessionId, 'recovered-task'));
  const listSchedules = jest.fn()
    .mockRejectedValueOnce(new Error('schedule snapshot timeout'))
    .mockResolvedValueOnce(schedulesResponse(sessionId, 'recovered-schedule'));
  const api = apiWithLists({ tasks: listTasks, schedules: listSchedules });
  const screen = render(
    <>
      <ClaudeRuntimeTasksStrip sessionId={sessionId} api={api} />
      <ClaudeRuntimeSchedulesStrip sessionId={sessionId} api={api} />
    </>,
  );

  await waitFor(() => {
    expect(listTasks).toHaveBeenCalledTimes(1);
    expect(listSchedules).toHaveBeenCalledTimes(1);
  });
  expect(screen.getByTestId('runtime-tasks-refresh-touch')).toBeTruthy();
  expect(screen.getByLabelText('예약 새로고침')).toBeTruthy();
  expect(screen.getAllByText('목록 미확인')).toHaveLength(2);
  expect(screen.queryAllByText('0')).toHaveLength(0);

  fireEvent.press(screen.getByTestId('runtime-tasks-refresh-touch'));
  fireEvent.press(screen.getByLabelText('예약 새로고침'));
  await waitFor(() => {
    expect(useChatStore.getState().claudeRuntimeBySession[sessionId]).toMatchObject({
      tasks: { 'recovered-task': { taskId: 'recovered-task' } },
      schedules: { 'recovered-schedule': { scheduleId: 'recovered-schedule' } },
    });
  });
});

test('늦은 tasks GET은 기존 snapshot과 신규 SSE를 합치고 동일 task는 SSE 최신값을 이긴다', async () => {
  const sessionId = 'session-task-race';
  const pending = deferred<ClaudeRuntimeTasksResponse>();
  const listTasks = jest.fn().mockReturnValue(pending.promise);
  const api = apiWithLists({ tasks: listTasks, schedules: jest.fn() });
  render(<ClaudeRuntimeTasksStrip sessionId={sessionId} api={api} />);
  await waitFor(() => expect(listTasks).toHaveBeenCalledTimes(1));

  act(() => useChatStore.getState().applyClaudeRuntimeEvent(
    sessionId,
    'claude_runtime_task_started',
    { task_id: 'live-task', status: 'running', timestamp: 20 },
  ));
  act(() => useChatStore.getState().applyClaudeRuntimeEvent(
    sessionId,
    'claude_runtime_task_started',
    { task_id: 'shared-task', status: 'running', timestamp: 21 },
  ));
  await act(async () => pending.resolve({
    ...tasksResponse(sessionId),
    tasks: [
      { taskId: 'snapshot-task', status: 'completed', updatedAt: 10 },
      { taskId: 'shared-task', status: 'pending', updatedAt: 10 },
    ],
  }));

  expect(useChatStore.getState().claudeRuntimeBySession[sessionId].tasks).toMatchObject({
    'snapshot-task': { taskId: 'snapshot-task', status: 'completed' },
    'live-task': expect.objectContaining({ taskId: 'live-task' }),
    'shared-task': { taskId: 'shared-task', status: 'running' },
  });
});

test('늦은 schedules GET은 snapshot과 SSE를 합치고 최신 변경·삭제 tombstone을 보존한다', async () => {
  const sessionId = 'session-schedule-race';
  const pending = deferred<ClaudeRuntimeSchedulesResponse>();
  const listSchedules = jest.fn().mockReturnValue(pending.promise);
  const api = apiWithLists({ tasks: jest.fn(), schedules: listSchedules });
  render(<ClaudeRuntimeSchedulesStrip sessionId={sessionId} api={api} />);
  await waitFor(() => expect(listSchedules).toHaveBeenCalledTimes(1));

  act(() => useChatStore.getState().applyClaudeRuntimeEvent(
    sessionId,
    'claude_runtime_schedule_updated',
    {
      schedule_id: 'live-schedule',
      schedule_kind: 'wakeup',
      status: 'active',
      next_run_at: '2026-09-07T23:00:00.000Z',
      timestamp: 20,
    },
  ));
  act(() => useChatStore.getState().applyClaudeRuntimeEvent(
    sessionId,
    'claude_runtime_schedule_updated',
    {
      schedule_id: 'shared-schedule',
      schedule_kind: 'wakeup',
      status: 'active',
      next_run_at: '2026-09-07T22:00:00.000Z',
      timestamp: 21,
    },
  ));
  act(() => useChatStore.getState().applyClaudeRuntimeEvent(
    sessionId,
    'claude_runtime_schedule_deleted',
    { schedule_id: 'deleted-schedule', timestamp: 22 },
  ));
  await act(async () => pending.resolve({
    sessionId,
    nextRunAt: '2026-09-08T00:00:00.000Z',
    schedules: [
      ...schedulesResponse(sessionId, 'snapshot-schedule').schedules,
      ...schedulesResponse(sessionId, 'shared-schedule').schedules,
      ...schedulesResponse(sessionId, 'deleted-schedule').schedules,
    ],
  }));

  expect(useChatStore.getState().claudeRuntimeBySession[sessionId].schedules).toMatchObject({
    'snapshot-schedule': { scheduleId: 'snapshot-schedule' },
    'live-schedule': expect.objectContaining({ scheduleId: 'live-schedule' }),
    'shared-schedule': {
      scheduleId: 'shared-schedule',
      nextRunAt: '2026-09-07T22:00:00.000Z',
    },
  });
  expect(useChatStore.getState().claudeRuntimeBySession[sessionId].schedules)
    .not.toHaveProperty('deleted-schedule');
});

test('세션 또는 api가 바뀐 뒤 도착한 이전 GET은 이전 scope에도 commit하지 않는다', async () => {
  const oldTasks = deferred<ClaudeRuntimeTasksResponse>();
  const oldApi = apiWithLists({
    tasks: jest.fn().mockReturnValue(oldTasks.promise),
    schedules: jest.fn(),
  });
  const newApi = apiWithLists({
    tasks: jest.fn().mockResolvedValue(tasksResponse('session-new-scope', 'new-task')),
    schedules: jest.fn(),
  });
  const screen = render(
    <ClaudeRuntimeTasksStrip sessionId="session-old-scope" api={oldApi} />,
  );
  await waitFor(() => expect(oldApi.listClaudeBackgroundTasks).toHaveBeenCalledTimes(1));

  screen.rerender(
    <ClaudeRuntimeTasksStrip sessionId="session-new-scope" api={newApi} />,
  );
  await waitFor(() => expect(newApi.listClaudeBackgroundTasks).toHaveBeenCalledTimes(1));
  await act(async () => oldTasks.resolve(tasksResponse('session-old-scope', 'stale-task')));

  expect(useChatStore.getState().claudeRuntimeBySession['session-old-scope']).toBeUndefined();
  expect(useChatStore.getState().claudeRuntimeBySession['session-new-scope'].tasks)
    .toHaveProperty('new-task');
});

test('같은 tick에 auth scope가 바뀌면 이전 GET은 effect cleanup 전에도 commit하지 않는다', async () => {
  const sessionId = 'session-auth-scope';
  const oldTasks = deferred<ClaudeRuntimeTasksResponse>();
  const newTasks = deferred<ClaudeRuntimeTasksResponse>();
  const listTasks = jest.fn()
    .mockReturnValueOnce(oldTasks.promise)
    .mockReturnValueOnce(newTasks.promise);
  const api = apiWithLists({ tasks: listTasks, schedules: jest.fn() });
  render(<ClaudeRuntimeTasksStrip sessionId={sessionId} api={api} />);
  await waitFor(() => expect(listTasks).toHaveBeenCalledTimes(1));

  await act(async () => {
    useAuthStore.setState({ jwt: 'new-auth-scope' });
    oldTasks.resolve(tasksResponse(sessionId, 'stale-auth-task'));
    await Promise.resolve();
  });
  await waitFor(() => expect(listTasks).toHaveBeenCalledTimes(2));
  await act(async () => newTasks.resolve(tasksResponse(sessionId, 'new-auth-task')));

  expect(useChatStore.getState().claudeRuntimeBySession[sessionId].tasks)
    .toHaveProperty('new-auth-task');
  expect(useChatStore.getState().claudeRuntimeBySession[sessionId].tasks)
    .not.toHaveProperty('stale-auth-task');
});

test('같은 tick에 auth scope가 바뀌면 이전 수동 조회 오류도 Alert로 노출하지 않는다', async () => {
  const sessionId = 'session-auth-error-scope';
  const manualTasks = deferred<ClaudeRuntimeTasksResponse>();
  const listTasks = jest.fn()
    .mockResolvedValueOnce(tasksResponse(sessionId, 'initial-task'))
    .mockReturnValueOnce(manualTasks.promise)
    .mockResolvedValueOnce(tasksResponse(sessionId, 'new-auth-task'));
  const api = apiWithLists({ tasks: listTasks, schedules: jest.fn() });
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  const screen = render(<ClaudeRuntimeTasksStrip sessionId={sessionId} api={api} />);
  await waitFor(() => {
    expect(listTasks).toHaveBeenCalledTimes(1);
    expect(useChatStore.getState().claudeRuntimeBySession[sessionId].tasks)
      .toHaveProperty('initial-task');
  });

  fireEvent.press(screen.getByTestId('runtime-tasks-refresh-touch'));
  await waitFor(() => expect(listTasks).toHaveBeenCalledTimes(2));
  await act(async () => {
    useAuthStore.setState({ jwt: 'next-auth-scope' });
    manualTasks.reject(new Error('stale auth error'));
    await Promise.resolve();
  });

  await waitFor(() => expect(listTasks).toHaveBeenCalledTimes(3));
  expect(alert).not.toHaveBeenCalled();
  expect(useChatStore.getState().claudeRuntimeBySession[sessionId].tasks)
    .toHaveProperty('new-auth-task');
});

test('clearSession은 진행 중인 GET의 reset barrier이며 수동 재조회만 다시 반영한다', async () => {
  const sessionId = 'session-cleared-during-get';
  const oldTasks = deferred<ClaudeRuntimeTasksResponse>();
  const listTasks = jest.fn()
    .mockReturnValueOnce(oldTasks.promise)
    .mockResolvedValueOnce(tasksResponse(sessionId, 'retried-task'));
  const api = apiWithLists({ tasks: listTasks, schedules: jest.fn() });
  const screen = render(<ClaudeRuntimeTasksStrip sessionId={sessionId} api={api} />);
  await waitFor(() => expect(listTasks).toHaveBeenCalledTimes(1));

  act(() => useChatStore.getState().clearSession(sessionId));
  await act(async () => oldTasks.resolve(tasksResponse(sessionId, 'stale-task')));

  expect(useChatStore.getState().claudeRuntimeBySession[sessionId]).toBeUndefined();
  expect(listTasks).toHaveBeenCalledTimes(1);
  expect(screen.getByText('목록 미확인')).toBeTruthy();

  fireEvent.press(screen.getByTestId('runtime-tasks-refresh-touch'));
  await waitFor(() => {
    expect(listTasks).toHaveBeenCalledTimes(2);
    expect(useChatStore.getState().claudeRuntimeBySession[sessionId].tasks)
      .toHaveProperty('retried-task');
  });
});
