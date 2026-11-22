import { fireEvent, render, waitFor } from '@testing-library/react-native';

jest.mock('../../../api/client', () => ({ createApiClient: jest.fn() }));

import { createApiClient } from '../../../api/client';
import { RecurringJobEditor, RecurringJobsList } from '../RecurringJobViews';

const eventJob = {
  job_id: 'job-event', name: '노드 트리거', prompt: '기존 지시문', timezone: 'Asia/Seoul',
  schedule_kind: 'event' as const, run_at: null,
  event_trigger: {
    type: 'node_connected' as const,
    node_id: 'silent-manari-ts',
    settle_seconds: 180,
    cooldown_seconds: 3600,
    repeat: false,
  },
  event_last_fired_at: null,
  schedule_expressions: [], node_id: 'node-a', agent_id: 'agent-a', model_preset: null,
  folder_id: 'folder-a', late_run_window_seconds: 1800, enabled: true, archived_at: null,
  next_run_at: null, version: 3,
  created_at: '2026-09-21T00:00:00.000Z', updated_at: '2026-09-21T00:00:00.000Z',
};

beforeEach(() => {
  jest.clearAllMocks();
});

test('event 작업 목록 행은 트리거 노드 조건을 보인다', async () => {
  const api = { listRecurringJobs: jest.fn().mockResolvedValue({ jobs: [eventJob] }) };
  (createApiClient as jest.Mock).mockReturnValue(api);
  const screen = render(
    <RecurringJobsList serverUrl="https://soul.test" onCreate={jest.fn()} onEdit={jest.fn()} />,
  );

  expect(await screen.findByText('silent-manari-ts가 붙으면 · 1회')).toBeTruthy();
});

test('event 작업 편집은 시간 선택기를 숨기고 PATCH에 schedule_expressions를 보내지 않는다', async () => {
  const api = {
    listNodes: jest.fn().mockResolvedValue({ nodes: [{ nodeId: 'node-a' }] }),
    listRecurringJobs: jest.fn().mockResolvedValue({ jobs: [eventJob] }),
    listNodeAgents: jest.fn().mockResolvedValue({ agents: [{ id: 'agent-a', name: '에이전트 A' }] }),
    listModelPresets: jest.fn().mockResolvedValue({ model_presets: [] }),
    updateRecurringJob: jest.fn().mockResolvedValue({
      job: { ...eventJob, name: '바꾼 이름', version: 4 },
    }),
  };
  (createApiClient as jest.Mock).mockReturnValue(api);
  const screen = render(
    <RecurringJobEditor serverUrl="https://soul.test" jobId="job-event" onDone={jest.fn()} onOpenHistory={jest.fn()} />,
  );

  await waitFor(() => expect(screen.getByLabelText('작업 이름').props.value).toBe(eventJob.name));
  expect(screen.getByText('silent-manari-ts가 붙으면 · 1회')).toBeTruthy();
  expect(screen.queryByTestId('recurring-schedule-picker')).toBeNull();
  expect(screen.queryByText('다음 5회')).toBeNull();

  fireEvent.changeText(screen.getByLabelText('작업 이름'), '바꾼 이름');
  fireEvent.press(screen.getByText('저장'));

  await waitFor(() => expect(api.updateRecurringJob).toHaveBeenCalled());
  const body = api.updateRecurringJob.mock.calls[0]?.[1];
  expect(body).toMatchObject({ expected_version: 3, name: '바꾼 이름' });
  expect(body).not.toHaveProperty('schedule_expressions');
  expect(body).not.toHaveProperty('run_at');
});
