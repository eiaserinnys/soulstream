import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

jest.mock('../../../api/client', () => ({ createApiClient: jest.fn() }));

import { createApiClient } from '../../../api/client';
import { ApiHttpError } from '../../../api/clientCore';
import { RecurringJobEditor } from '../RecurringJobViews';

const job = {
  job_id: 'job-1', name: '음악 추천', prompt: '기존 지시문', timezone: 'Asia/Seoul',
  schedule_expressions: ['0 9 * * 1-5'], node_id: 'node-a', agent_id: 'agent-a',
  model_preset: null, folder_id: 'folder-a', container: { kind: 'folder' as const, id: 'folder-a' },
  late_run_window_seconds: 1800, enabled: true, archived_at: null,
  next_run_at: '2026-09-22T00:00:00.000Z', version: 4,
  created_at: '2026-09-21T00:00:00.000Z', updated_at: '2026-09-21T00:00:00.000Z',
};

test('version conflict reloads the durable version while preserving the mobile draft', async () => {
  const api = {
    listNodes: jest.fn().mockResolvedValue({ nodes: [{ nodeId: 'node-a' }] }),
    listRecurringJobs: jest.fn().mockResolvedValue({ jobs: [job] }),
    listNodeAgents: jest.fn().mockResolvedValue({ agents: [{ id: 'agent-a', name: '에이전트 A' }] }),
    listModelPresets: jest.fn().mockResolvedValue({ model_presets: [] }),
    updateRecurringJob: jest.fn().mockRejectedValue(new ApiHttpError('conflict', 409, '')),
  };
  (createApiClient as jest.Mock).mockReturnValue(api);
  const screen = render(
    <RecurringJobEditor serverUrl="https://soul.test" jobId="job-1" onDone={jest.fn()} onOpenHistory={jest.fn()} />,
  );

  const name = await screen.findByLabelText('작업 이름');
  fireEvent.changeText(name, '보존할 초안');
  fireEvent.press(screen.getByText('저장'));

  expect(await screen.findByText('다른 변경을 반영했습니다. 입력은 보존했습니다. 최신 버전으로 다시 저장하세요.')).toBeTruthy();
  expect(screen.getByLabelText('작업 이름').props.value).toBe('보존할 초안');
  expect(api.listRecurringJobs).toHaveBeenCalledTimes(2);
  await waitFor(() => expect(api.updateRecurringJob).toHaveBeenCalledWith(
    'job-1', expect.objectContaining({ expected_version: 4, name: '보존할 초안' }),
  ));
});


test('pausing the saved job preserves an unsaved editor draft', async () => {
  const api = {
    listNodes: jest.fn().mockResolvedValue({ nodes: [{ nodeId: 'node-a' }] }),
    listRecurringJobs: jest.fn().mockResolvedValue({ jobs: [job] }),
    listNodeAgents: jest.fn().mockResolvedValue({ agents: [{ id: 'agent-a', name: '에이전트 A' }] }),
    listModelPresets: jest.fn().mockResolvedValue({ model_presets: [] }),
    updateRecurringJob: jest.fn().mockResolvedValue({ job: { ...job, enabled: false, version: 5 } }),
  };
  (createApiClient as jest.Mock).mockReturnValue(api);
  const onDone = jest.fn();
  const screen = render(<RecurringJobEditor serverUrl="https://soul.test" jobId="job-1" onDone={onDone} onOpenHistory={jest.fn()}/>);
  await waitFor(() => expect(screen.getByLabelText('작업 이름').props.value).toBe(job.name));
  fireEvent.changeText(screen.getByLabelText('작업 이름'), 'keep my draft');
  fireEvent.press(screen.getByTestId('recurring-job-toggle-enabled'));
  await waitFor(() => expect(api.updateRecurringJob).toHaveBeenCalled());
  expect(screen.getByLabelText('작업 이름').props.value).toBe('keep my draft');
  expect(onDone).not.toHaveBeenCalled();
});


test('일정 변경 뒤 늦게 도착한 다음 실행 미리보기는 현재 일정에 표시하지 않는다', async () => {
  let resolve!: (value: unknown) => void;
  const api = {
    listNodes: jest.fn().mockResolvedValue({ nodes: [] }),
    listRecurringJobs: jest.fn().mockResolvedValue({ jobs: [job] }),
    listNodeAgents: jest.fn().mockResolvedValue({ agents: [] }),
    listModelPresets: jest.fn().mockResolvedValue({ model_presets: [] }),
    previewRecurringSchedule: jest.fn().mockImplementation(() => new Promise(yes => { resolve = yes; })),
  };
  jest.mocked(createApiClient).mockReturnValue(api as any);
  const screen = render(<RecurringJobEditor serverUrl="https://soul.test" jobId="job-1" onDone={jest.fn()} onOpenHistory={jest.fn()}/>);
  await waitFor(() => expect(screen.getByLabelText('작업 이름').props.value).toBe(job.name));
  fireEvent.press(screen.getByText('다음 5회'));
  fireEvent.press(screen.getByTestId('recurring-schedule-mode-monthly'));
  await act(async () => resolve({ nextRuns: ['2026-10-06T00:00:00Z'] }));
  expect(screen.getAllByText('다음 5회')).toHaveLength(1);
});

test('목록에서 사라진 작업은 오류와 다시 조회를 보여주며 새 작업으로 저장하지 않는다', async () => {
  const api = { listNodes: jest.fn().mockResolvedValue({ nodes: [] }), listRecurringJobs: jest.fn().mockResolvedValue({ jobs: [] }) };
  jest.mocked(createApiClient).mockReturnValue(api as any);
  const screen = render(<RecurringJobEditor serverUrl="https://soul.test" jobId="missing" onDone={jest.fn()} onOpenHistory={jest.fn()}/>);
  await screen.findByText('반복 작업을 찾을 수 없습니다.');
  expect(screen.getByText('다시 불러오기')).toBeTruthy();
  fireEvent.press(screen.getByText('저장'));
  expect(api.listRecurringJobs).toHaveBeenCalledTimes(1);
});
