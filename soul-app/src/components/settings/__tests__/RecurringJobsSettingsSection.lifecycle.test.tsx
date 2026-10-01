import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';

jest.mock('../../../api/client', () => ({ createApiClient: jest.fn() }));
jest.mock('../../../lib/planner-folder-workspace', () => ({ openPlannerSessionWorkspace: jest.fn() }));

import { createApiClient } from '../../../api/client';
import { openPlannerSessionWorkspace } from '../../../lib/planner-folder-workspace';
import { useSessionStore } from '../../../store/sessionStore';
import { RecurringJobsSettingsSection } from '../RecurringJobsSettingsSection';

const api = {
  listRecurringJobs: jest.fn(),
  listNodes: jest.fn(),
  listNodeAgents: jest.fn(),
  listModelPresets: jest.fn(),
  getProjectTasks: jest.fn(),
  previewRecurringSchedule: jest.fn(),
  createRecurringJob: jest.fn(),
  updateRecurringJob: jest.fn(),
  listRecurringJobRuns: jest.fn(),
  runRecurringJob: jest.fn(),
  archiveRecurringJob: jest.fn(),
};

let job: Record<string, any> | null;

beforeEach(() => {
  jest.clearAllMocks();
  job = null;
  (createApiClient as jest.Mock).mockReturnValue(api);
  api.listNodes.mockResolvedValue({ nodes: [{ nodeId: 'node-a' }] });
  api.listNodeAgents.mockResolvedValue({ agents: [{ id: 'agent-a', name: '에이전트 A' }] });
  api.listModelPresets.mockResolvedValue({ model_presets: [] });
  api.getProjectTasks.mockResolvedValue({ items: [] });
  api.previewRecurringSchedule.mockResolvedValue({ nextRuns: [] });
  api.listRecurringJobs.mockImplementation(async () => ({ jobs: job ? [job] : [] }));
  api.createRecurringJob.mockImplementation(async (input) => {
    job = {
      ...input,
      job_id: 'job-1',
      version: 1,
      archived_at: null,
      next_run_at: '2026-09-22T00:00:00.000Z',
      created_at: '2026-09-21T00:00:00.000Z',
      updated_at: '2026-09-21T00:00:00.000Z',
    };
    return { job };
  });
  api.updateRecurringJob.mockImplementation(async (_jobId, input) => {
    job = { ...job, ...input, version: Number(job?.version ?? 0) + 1 };
    return { job };
  });
  api.listRecurringJobRuns.mockResolvedValue({
    runs: [{
      run_id: 'run-1', job_id: 'job-1', trigger: 'scheduled', scheduled_for: '2026-09-22T00:00:00.000Z',
      session_id: 'session-1', state: 'completed', reason_code: null, reason_message: null,
      job_snapshot: {}, created_at: '2026-09-22T00:00:00.000Z', started_at: null,
      finished_at: '2026-09-22T00:00:00.000Z', updated_at: '2026-09-22T00:00:00.000Z',
    }, {
      run_id: 'run-skipped', job_id: 'job-1', trigger: 'scheduled', scheduled_for: '2026-09-22T00:00:00.000Z',
      session_id: 'reserved-but-not-created', state: 'skipped_late', reason_code: 'LATE_RUN_WINDOW_EXPIRED',
      reason_message: 'The occurrence expired before any session was sent.', job_snapshot: {},
      created_at: '2026-09-22T00:00:00.000Z', started_at: null,
      finished_at: '2026-09-22T00:00:00.000Z', updated_at: '2026-09-22T00:00:00.000Z',
    }, {
      run_id: 'run-before-send', job_id: 'job-1', trigger: 'scheduled', scheduled_for: '2026-09-22T00:00:00.000Z',
      session_id: 'never-created', state: 'error', reason_code: 'CREATE_SESSION_BEFORE_SEND_FAILED',
      reason_message: 'The node was unavailable before the create_session command was sent.', job_snapshot: {},
      created_at: '2026-09-22T00:00:00.000Z', started_at: null,
      finished_at: '2026-09-22T00:00:00.000Z', updated_at: '2026-09-22T00:00:00.000Z',
    }, {
      run_id: 'run-after-send', job_id: 'job-1', trigger: 'scheduled', scheduled_for: '2026-09-22T00:00:00.000Z',
      session_id: 'possibly-created', state: 'error', reason_code: 'CREATE_SESSION_REJECTED',
      reason_message: 'The node returned an error after the request was sent; check the fixed session ID.', job_snapshot: {},
      created_at: '2026-09-22T00:00:00.000Z', started_at: null,
      finished_at: '2026-09-22T00:00:00.000Z', updated_at: '2026-09-22T00:00:00.000Z',
    }],
  });
  api.archiveRecurringJob.mockImplementation(async (_jobId, version) => {
    job = {
      ...job,
      enabled: false,
      archived_at: '2026-09-22T00:01:00.000Z',
      version: version + 1,
    };
    return { job };
  });
  useSessionStore.setState((state) => ({
    catalog: {
      ...state.catalog,
      folders: [{ id: 'folder-a', name: '음악', sortOrder: 1, projectPageId: 'project-a' }],
    },
  }));
});

test('wide UI registers, edits, pauses, resumes, and opens recurring run history without raw IDs', async () => {
  const screen = render(<RecurringJobsSettingsSection flattened serverUrl="https://soul.test" />);

  fireEvent.press(await screen.findByText('새 작업'));
  await screen.findByTestId('recurring-job-editor');
  fireEvent.changeText(screen.getByLabelText('작업 이름'), '음악 추천');
  fireEvent.changeText(screen.getByLabelText('작업 내용'), '기존 음악 추천 지시문을 실행한다.');
  fireEvent.press(await screen.findByText('node-a'));
  fireEvent.press(await screen.findByText('에이전트 A'));
  fireEvent.press(screen.getByText('음악'));
  expect(screen.queryByLabelText('결과 폴더 ID')).toBeNull();
  expect(screen.queryByLabelText('결과 컨테이너 ID')).toBeNull();
  fireEvent.press(screen.getByText('저장'));

  await waitFor(() => expect(api.createRecurringJob).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(screen.queryByTestId('recurring-job-editor')).toBeNull());
  expect(await screen.findByTestId('recurring-job-job-1')).toBeTruthy();
  expect(api.createRecurringJob).toHaveBeenCalledWith(expect.objectContaining({
    schedule_expressions: ['0 9 * * 1-5'],
    folder_id: 'folder-a',
  }));
  expect(api.createRecurringJob.mock.calls[0][0]).not.toHaveProperty('container');

  fireEvent.press(screen.getByTestId('recurring-job-job-1'));
  fireEvent.changeText(await screen.findByLabelText('작업 이름'), '음악 추천 수정');
  fireEvent.press(screen.getByText('저장'));
  await waitFor(() => expect(api.updateRecurringJob).toHaveBeenCalledWith(
    'job-1', expect.objectContaining({ name: '음악 추천 수정' }),
  ));
  await waitFor(() => expect(screen.queryByTestId('recurring-job-editor')).toBeNull());
  expect(await screen.findByTestId('recurring-job-job-1')).toBeTruthy();

  fireEvent.press(screen.getByTestId('recurring-job-job-1'));
  fireEvent.press(await screen.findByTestId('recurring-job-toggle-enabled'));
  await waitFor(() => expect(api.updateRecurringJob).toHaveBeenCalledWith(
    'job-1', expect.objectContaining({ enabled: false }),
  ));
  await waitFor(() => expect(screen.queryByTestId('recurring-job-editor')).toBeNull());
  fireEvent.press(await screen.findByTestId('recurring-job-job-1'));
  fireEvent.press(await screen.findByTestId('recurring-job-toggle-enabled'));
  await waitFor(() => expect(api.updateRecurringJob).toHaveBeenCalledWith(
    'job-1', expect.objectContaining({ enabled: true }),
  ));
  await waitFor(() => expect(screen.queryByTestId('recurring-job-editor')).toBeNull());

  fireEvent.press(await screen.findByTestId('recurring-job-job-1'));
  fireEvent.press(await screen.findByTestId('recurring-job-archive'));
  await waitFor(() => expect(api.archiveRecurringJob).toHaveBeenCalledWith('job-1', 4));
  await waitFor(() => expect(screen.queryByTestId('recurring-job-editor')).toBeNull());
  expect(await screen.findByText('보관됨')).toBeTruthy();

  fireEvent.press(await screen.findByTestId('recurring-job-job-1'));
  fireEvent.press(await screen.findByTestId('recurring-job-history'));
  fireEvent.press(await screen.findByTestId('recurring-run-open-run-1'));
  expect(openPlannerSessionWorkspace).toHaveBeenCalledWith('session-1');
  expect(screen.getByTestId('recurring-run-open-run-after-send').props.accessibilityState.disabled).toBe(false);
  fireEvent.press(screen.getByTestId('recurring-run-open-run-after-send'));
  expect(openPlannerSessionWorkspace).toHaveBeenCalledWith('possibly-created');
  expect(screen.getByTestId('recurring-run-open-run-skipped').props.accessibilityState.disabled).toBe(true);
  expect(screen.getByTestId('recurring-run-open-run-before-send').props.accessibilityState.disabled).toBe(true);
  expect(screen.getByText('The occurrence expired before any session was sent.')).toBeTruthy();
  expect(screen.getByText('The node was unavailable before the create_session command was sent.')).toBeTruthy();
  expect(screen.getByText('The node returned an error after the request was sent; check the fixed session ID.')).toBeTruthy();
  await waitFor(() => expect(api.updateRecurringJob).toHaveBeenCalledWith(
    'job-1', expect.objectContaining({ enabled: true }),
  ));
});
