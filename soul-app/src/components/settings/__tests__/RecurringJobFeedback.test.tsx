import React, { useState } from 'react';
import { ActivityIndicator, ScrollView } from 'react-native';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

jest.mock('../../../api/client', () => ({ createApiClient: jest.fn() }));
const mockNotices: string[] = [];
jest.mock('../SettingsFormParts', () => {
  const actual = jest.requireActual('../SettingsFormParts');
  return { ...actual, SettingsNotice: (props: any) => { mockNotices.push(props.text); return actual.SettingsNotice(props); } };
});
import { createApiClient } from '../../../api/client';
import { ApiHttpError } from '../../../api/clientCore';
import { RecurringJobEditor, RecurringJobsList } from '../RecurringJobViews';
import { RecurringJobsSettingsSection } from '../RecurringJobsSettingsSection';
import { SettingsWorkspaceContext, type SettingsSaveScope } from '../SettingsWorkspaceContext';

afterEach(() => { jest.restoreAllMocks(); });

const job = {
  job_id: 'job-1', name: '아침 작업 확인', prompt: '오늘 할 일을 정리합니다.', timezone: 'Asia/Seoul',
  schedule_expressions: ['0 9 * * 1-5'], node_id: 'node-a', agent_id: 'agent-a', model_preset: null,
  folder_id: 'folder-a', late_run_window_seconds: 1800, enabled: true, archived_at: null,
  next_run_at: '2026-09-22T00:00:00.000Z', version: 4,
  created_at: '2026-09-21T00:00:00.000Z', updated_at: '2026-09-21T00:00:00.000Z',
};
const makeApi = () => ({
  listRecurringJobs: jest.fn().mockResolvedValue({ jobs: [job] }),
  listNodes: jest.fn().mockResolvedValue({ nodes: [{ nodeId: 'node-a' }] }),
  listNodeAgents: jest.fn().mockResolvedValue({ agents: [] }),
  listModelPresets: jest.fn().mockResolvedValue({ model_presets: [] }),
  updateRecurringJob: jest.fn().mockRejectedValue(new Error('HTTP 503')),
  runRecurringJob: jest.fn().mockRejectedValue(new Error('HTTP 503')),
});
const list = () => <RecurringJobsList serverUrl="https://soul.test" onCreate={jest.fn()} onEdit={jest.fn()} />;
const editor = () => <RecurringJobEditor serverUrl="https://soul.test" jobId="job-1" onDone={jest.fn()} onOpenHistory={jest.fn()} />;
const spyOnScroll = (screen: ReturnType<typeof render>, testID: string) => {
  const scroll = screen.UNSAFE_getAllByType(ScrollView).find(node => node.props.testID === testID)!;
  const spy = jest.spyOn(scroll.instance, 'scrollToEnd').mockImplementation(() => {});
  spy.mockClear();
  return spy;
};
const visibleOrder = (screen: ReturnType<typeof render>, before: string, after: string) => {
  const tree = JSON.stringify(screen.toJSON());
  expect(tree.indexOf(before)).toBeGreaterThan(-1);
  expect(tree.indexOf(after)).toBeGreaterThan(tree.indexOf(before));
};

test.each(['empty', 'jobs', 'failure'])('첫 조회 %s 응답 전에는 로딩을 보이고 빈 상태를 보이지 않는다', async outcome => {
  let finish!: (value: any) => void;
  let fail!: (error: Error) => void;
  const api = makeApi();
  api.listRecurringJobs.mockReturnValue(new Promise((resolve, reject) => { finish = resolve; fail = reject; }));
  jest.mocked(createApiClient).mockReturnValue(api as any);
  mockNotices.length = 0;
  const screen = render(list());
  expect(mockNotices).not.toContain('등록된 반복 작업이 없습니다.');
  expect(screen.queryByText('등록된 반복 작업이 없습니다.')).toBeNull();
  expect(screen.UNSAFE_getByType(ActivityIndicator)).toBeTruthy();
  await act(async () => outcome === 'failure' ? fail(new Error('조회 실패')) : finish({ jobs: outcome === 'empty' ? [] : [job] }));
  if (outcome === 'empty') expect(screen.getByText('등록된 반복 작업이 없습니다.')).toBeTruthy();
  else if (outcome === 'jobs') expect(screen.getByText(job.name)).toBeTruthy();
  else expect(screen.queryByText('등록된 반복 작업이 없습니다.')).toBeNull();
});

test('충돌 뒤 최신 작업 불러오기도 실패하면 충돌 안내만 아래에 남는다', async () => {
  const api = makeApi();
  api.listRecurringJobs.mockResolvedValueOnce({ jobs: [job] }).mockRejectedValueOnce(new Error('HTTP 503'));
  api.updateRecurringJob.mockRejectedValue(new ApiHttpError('conflict', 409, ''));
  jest.mocked(createApiClient).mockReturnValue(api as any);
  const screen = render(editor());
  await screen.findByDisplayValue(job.name);
  fireEvent.press(screen.getByText('저장'));
  await screen.findByText(/동시 수정은 감지됐지만/);
  visibleOrder(screen, '보관', '동시 수정은 감지됐지만');
  expect(screen.queryByText(/HTTP 503/)).toBeNull();
});

test.each(['server', 'validation', 'conflict'])('폰 %s 저장 실패는 저장 아래에서 매번 스크롤된다', async kind => {
  const api = makeApi();
  if (kind === 'conflict') api.updateRecurringJob.mockRejectedValue(new ApiHttpError('conflict', 409, ''));
  jest.mocked(createApiClient).mockReturnValue(api as any);
  const screen = render(editor());
  const scroll = spyOnScroll(screen, 'recurring-job-editor');
  await waitFor(() => expect(screen.getByLabelText('작업 이름').props.value).toBe(job.name));
  if (kind === 'validation') fireEvent.changeText(screen.getByLabelText('오프라인 허용 초'), '0');
  for (let attempt = 0; attempt < 2; attempt++) {
    fireEvent.press(screen.getByText('저장'));
    const message = kind === 'validation' ? '오프라인 허용 초는 1 이상의 정수여야 합니다.' : kind === 'conflict' ? '다른 곳에서 작업이 변경됐습니다.' : 'HTTP 503';
    const alert = await screen.findByText(new RegExp(message.replace('.', '\\.')));
    visibleOrder(screen, '저장', message);
    fireEvent(alert, 'layout');
    expect(scroll).toHaveBeenCalledTimes(attempt + 1);
  }
});

test('저장 서버 실패 안내는 첫 줄에 저장 동작을 밝히고 오류 상세를 그 아래에 둔다', async () => {
  const api = makeApi();
  jest.mocked(createApiClient).mockReturnValue(api as any);
  const screen = render(editor());
  await screen.findByDisplayValue(job.name);
  fireEvent.press(screen.getByText('저장'));
  const alert = await screen.findByText(/^저장하지 못했습니다\./);
  expect(alert.props.children.split('\n')[0]).toBe('저장하지 못했습니다.');
  expect(alert.props.children).toContain('HTTP 503');
});

test('지금 실행 서버 실패 안내는 첫 줄에 실행 동작을 밝힌다', async () => {
  const api = makeApi();
  jest.mocked(createApiClient).mockReturnValue(api as any);
  const screen = render(editor());
  await screen.findByDisplayValue(job.name);
  fireEvent.press(screen.getByTestId('recurring-job-run-now'));
  const alert = await screen.findByText(/^지금 실행하지 못했습니다\./);
  expect(alert.props.children.split('\n')[0]).toBe('지금 실행하지 못했습니다.');
  expect(alert.props.children).toContain('HTTP 503');
});

test('같은 실패 안내의 재배치는 스크롤하지 않고 다음 실패는 다시 스크롤한다', async () => {
  const api = makeApi();
  jest.mocked(createApiClient).mockReturnValue(api as any);
  const screen = render(editor());
  const scroll = spyOnScroll(screen, 'recurring-job-editor');
  await screen.findByDisplayValue(job.name);
  fireEvent.press(screen.getByText('저장'));
  const alert = await screen.findByText(/HTTP 503/);
  fireEvent(alert, 'layout');
  expect(scroll).toHaveBeenCalledTimes(1);
  fireEvent(alert, 'layout');
  expect(scroll).toHaveBeenCalledTimes(1);
  fireEvent.press(screen.getByText('저장'));
  const nextAlert = await screen.findByText(/HTTP 503/);
  fireEvent(nextAlert, 'layout');
  expect(scroll).toHaveBeenCalledTimes(2);
});

test('동작 실패는 아래, 불러오기 실패와 다시 불러오기는 위에 보인다', async () => {
  const api = makeApi();
  jest.mocked(createApiClient).mockReturnValue(api as any);
  const screen = render(editor());
  await screen.findByDisplayValue(job.name);
  fireEvent.press(screen.getByTestId('recurring-job-run-now'));
  await screen.findByText(/HTTP 503/);
  visibleOrder(screen, '보관', 'HTTP 503');
  screen.unmount();
  api.listRecurringJobs.mockResolvedValue({ jobs: [] });
  const missing = render(editor());
  await missing.findByText('반복 작업을 찾을 수 없습니다.');
  visibleOrder(missing, '반복 작업을 찾을 수 없습니다.', '새 반복 작업');
  expect(missing.getByText('다시 불러오기')).toBeTruthy();
});

test('넓은 화면 저장 scope 실패는 부모 편집 스크롤을 내린다', async () => {
  const api = makeApi();
  jest.mocked(createApiClient).mockReturnValue(api as any);
  let scope: SettingsSaveScope | null = null;
  function Shell() {
    const [jobs, setJobs] = useState<any>({ kind: 'editor', jobId: 'job-1' });
    const workspace: any = { category: 'recurring-jobs', wide: true, columns: true, jobs, setJobs, register: (_: string, value: SettingsSaveScope | null) => { scope = value; }, guard: (_: string, action: () => void) => action(), select: jest.fn() };
    return <SettingsWorkspaceContext.Provider value={workspace}><RecurringJobsSettingsSection flattened serverUrl="https://soul.test" /></SettingsWorkspaceContext.Provider>;
  }
  const screen = render(<Shell />);
  const scroll = spyOnScroll(screen, 'settings-jobs-editor-scroll');
  await screen.findByDisplayValue(job.name);
  await act(async () => { await scope!.save(); });
  const alert = await screen.findByText(/HTTP 503/);
  visibleOrder(screen, '보관', 'HTTP 503');
  fireEvent(alert, 'layout');
  expect(scroll).toHaveBeenCalledTimes(1);
});
