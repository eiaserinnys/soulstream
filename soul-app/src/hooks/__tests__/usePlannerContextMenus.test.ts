import { Alert, Platform } from 'react-native';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { ApiClient } from '../../api/client';
import type { PlannerFolder } from '../../api/plannerTypes';
import { showAppContextMenu } from '../../components/menus/AppContextMenu';
import { usePlannerStore } from '../../store/plannerStore';
import { useSessionStore } from '../../store/sessionStore';
import { usePlannerContextMenus } from '../usePlannerContextMenus';

jest.mock('../../components/menus/AppContextMenu', () => ({
  showAppContextMenu: jest.fn(),
}));

let api: ApiClient;
let apiMethods: {
  getResumeAfterLimit: jest.Mock;
  scheduleResumeAfterLimit: jest.Mock;
};

beforeEach(() => {
  jest.clearAllMocks();
  Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
  apiMethods = {
    getResumeAfterLimit: jest.fn().mockResolvedValue({
      eligible: true,
      reason: null,
      resets_at: '2026-09-28T09:00:00.000Z',
      schedule: null,
    }),
    scheduleResumeAfterLimit: jest.fn().mockResolvedValue({
      schedule_id: 'schedule-1',
      run_at: '2026-09-28T09:00:00.000Z',
      status: 'active',
      reused: false,
    }),
  };
  api = apiMethods as unknown as ApiClient;
  usePlannerStore.getState().resetForTest();
  usePlannerStore.setState({ selectedFolderSnapshot: folder });
  useSessionStore.setState({
    sessions: { 'session-1': folder.sessions[0] as any },
    catalog: { folders: [] } as any,
  });
});

async function openSessionMenu(
  result: { current: ReturnType<typeof usePlannerContextMenus> },
  sessionId = 'session-1',
) {
  act(() => result.current.openSessionMenu({ sessionId }));
  await waitFor(() => expect(showAppContextMenu).toHaveBeenCalledTimes(1));
}

test('세션 이름 변경은 취소·확인을 노출하고 공백 확인을 null로 정규화한다', async () => {
  const prompt = jest.spyOn(Alert, 'prompt').mockImplementation(jest.fn());
  const { result } = renderHook(() => usePlannerContextMenus(api));

  await openSessionMenu(result);
  const menu = (showAppContextMenu as jest.Mock).mock.calls[0][0];
  act(() => menu.find((item: any) => item.key === 'rename').onSelect());

  const buttons = prompt.mock.calls[0][2] as any[];
  expect(buttons.map(({ text, style }) => ({ text, style }))).toEqual([
    { text: '취소', style: 'cancel' },
    { text: '확인', style: undefined },
  ]);
  expect(() => buttons[1].onPress('   ')).not.toThrow();
});

test('세션 삭제는 destructive 확인 뒤에만 실행한다', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(jest.fn());
  const { result } = renderHook(() => usePlannerContextMenus(api));

  await openSessionMenu(result);
  const menu = (showAppContextMenu as jest.Mock).mock.calls[0][0];
  act(() => menu.find((item: any) => item.key === 'delete').onSelect());

  const buttons = alert.mock.calls[0][2] as any[];
  expect(buttons.map(({ text, style }) => ({ text, style }))).toEqual([
    { text: '취소', style: 'cancel' },
    { text: '확인', style: 'destructive' },
  ]);
});

test('메뉴의 세션 승계는 API를 즉시 호출하지 않고 확인 시트 요청을 만든다', async () => {
  const { result } = renderHook(() => usePlannerContextMenus(api));

  await openSessionMenu(result);
  const menu = (showAppContextMenu as jest.Mock).mock.calls[0][0];
  act(() => menu.find((item: any) => item.key === 'continue').onSelect());

  expect(result.current.sessionSuccession).toEqual({
    folder: folder,
    predecessorSessionId: 'session-1',
  });
});

test('planner store의 무관한 변경을 구독하지 않고 메뉴를 열 때 최신 상태를 읽는다', async () => {
  let renders = 0;
  const { result } = renderHook(() => {
    renders += 1;
    return usePlannerContextMenus(api);
  });

  act(() => {
    usePlannerStore.getState().setLoading('unrelated', true);
    usePlannerStore.setState({ selectedFolderSnapshot: {
      ...folder,
      page: { ...folder.page, title: '최신 업무' },
    } });
  });

  expect(renders).toBe(1);
  await openSessionMenu(result);
  const menu = (showAppContextMenu as jest.Mock).mock.calls[0][0];
  act(() => menu.find((item: any) => item.key === 'continue').onSelect());
  expect(result.current.sessionSuccession?.folder.page.title).toBe('최신 업무');
});

test('GET 응답 전에 메뉴를 열지 않고 같은 세션의 반복 조회를 막는다', async () => {
  let resolveRequest!: (value: unknown) => void;
  const request = new Promise((resolve) => { resolveRequest = resolve; });
  apiMethods.getResumeAfterLimit.mockReturnValue(request);
  const { result } = renderHook(() => usePlannerContextMenus(api));

  act(() => {
    result.current.openSessionMenu({ sessionId: 'session-1' });
    result.current.openSessionMenu({ sessionId: 'session-1' });
  });

  expect(apiMethods.getResumeAfterLimit).toHaveBeenCalledTimes(1);
  expect(apiMethods.getResumeAfterLimit).toHaveBeenCalledWith('session-1');
  expect(showAppContextMenu).not.toHaveBeenCalled();

  await act(async () => {
    resolveRequest({
      eligible: false,
      reason: '해제 시각을 확인할 수 없습니다.',
      resets_at: null,
      schedule: null,
    });
    await request;
  });

  await waitFor(() => expect(showAppContextMenu).toHaveBeenCalledTimes(1));
  const menu = (showAppContextMenu as jest.Mock).mock.calls[0][0];
  expect(menu.find((item: any) => item.key === 'resume-after-limit')).toMatchObject({
    label: '리밋이 풀릴 때 재개',
    disabled: true,
    disabledReason: '해제 시각을 확인할 수 없습니다.',
  });
});

test.each(['active', 'dispatching', 'firing', 'orphaned'])(
  '예약 상태 %s는 새 예약을 막고 현지 시각을 안내한다',
  async (status: string) => {
    const runAt = '2026-09-28T09:05:00.000Z';
    apiMethods.getResumeAfterLimit.mockResolvedValue({
      eligible: true,
      reason: null,
      resets_at: null,
      schedule: { schedule_id: 'schedule-1', run_at: runAt, status },
    });
    const { result } = renderHook(() => usePlannerContextMenus(api));

    await openSessionMenu(result);

    const menu = (showAppContextMenu as jest.Mock).mock.calls[0][0];
    const resumeAction = menu.find((item: any) => item.key === 'resume-after-limit');
    const localDate = new Date(runAt);
    const localTime = `${localDate.getMonth() + 1}월 ${localDate.getDate()}일 ${String(localDate.getHours()).padStart(2, '0')}:${String(localDate.getMinutes()).padStart(2, '0')}`;
    expect(resumeAction).toMatchObject({
      disabled: true,
      disabledReason: expect.stringContaining(localTime),
    });
    expect(apiMethods.scheduleResumeAfterLimit).not.toHaveBeenCalled();
  },
);

test('GET 실패는 기존 오류 Alert 확인 뒤 비활성 예약 항목과 세션 메뉴를 보여준다', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(jest.fn());
  apiMethods.getResumeAfterLimit.mockRejectedValue(new Error('network unavailable'));
  const { result } = renderHook(() => usePlannerContextMenus(api));

  act(() => result.current.openSessionMenu({ sessionId: 'session-1' }));

  await waitFor(() => expect(alert).toHaveBeenCalledWith(
    '작업을 완료하지 못했습니다.',
    'network unavailable',
    expect.any(Array),
  ));
  expect(showAppContextMenu).not.toHaveBeenCalled();
  act(() => (alert.mock.calls[0][2] as any[])[0].onPress());

  expect(showAppContextMenu).toHaveBeenCalledTimes(1);
  const menu = (showAppContextMenu as jest.Mock).mock.calls[0][0];
  expect(menu.map((item: any) => item.key)).toContain('rename');
  expect(menu.find((item: any) => item.key === 'resume-after-limit')).toMatchObject({
    label: '리밋이 풀릴 때 재개',
    disabled: true,
    disabledReason: '예약 가능 여부를 확인하지 못했습니다.',
  });
});

test('POST는 중복 탭을 막고 서버의 현지 예약 시각을 알린다', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(jest.fn());
  let resolveRequest!: (value: unknown) => void;
  const request = new Promise((resolve) => { resolveRequest = resolve; });
  apiMethods.scheduleResumeAfterLimit.mockReturnValue(request);
  const runAt = '2026-09-28T09:05:00.000Z';
  const { result } = renderHook(() => usePlannerContextMenus(api));

  await openSessionMenu(result);
  const menu = (showAppContextMenu as jest.Mock).mock.calls[0][0];
  const resumeAction = menu.find((item: any) => item.key === 'resume-after-limit');
  act(() => {
    void resumeAction.onSelect();
    void resumeAction.onSelect();
  });
  expect(apiMethods.scheduleResumeAfterLimit).toHaveBeenCalledTimes(1);
  expect(apiMethods.scheduleResumeAfterLimit).toHaveBeenCalledWith('session-1');

  await act(async () => {
    resolveRequest({
      schedule_id: 'schedule-1',
      run_at: runAt,
      status: 'active',
      reused: false,
    });
    await request;
  });

  const localDate = new Date(runAt);
  const localTime = `${localDate.getMonth() + 1}월 ${localDate.getDate()}일 ${String(localDate.getHours()).padStart(2, '0')}:${String(localDate.getMinutes()).padStart(2, '0')}`;
  await waitFor(() => expect(alert).toHaveBeenCalledWith(
    '재개 예약',
    `${localTime} 재개 예약`,
  ));
});

test('POST 실패는 오류를 알리고 예약 성공으로 표시하지 않는다', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(jest.fn());
  apiMethods.scheduleResumeAfterLimit.mockRejectedValue(new Error('schedule failed'));
  const { result } = renderHook(() => usePlannerContextMenus(api));

  await openSessionMenu(result);
  const menu = (showAppContextMenu as jest.Mock).mock.calls[0][0];
  await act(async () => {
    await menu.find((item: any) => item.key === 'resume-after-limit').onSelect();
  });

  expect(alert).toHaveBeenCalledWith('작업을 완료하지 못했습니다.', 'schedule failed');
  expect(alert.mock.calls.some(([, message]) => String(message).includes('재개 예약'))).toBe(false);
});

const folder = {
  page: {
    id: 'task-1', title: '업무', dailyDate: null, version: 1, archived: false,
    metadata: {}, createdAt: '', updatedAt: '',
  },
  blocks: [], folderId: 'task-1', folderSummary: null, status: 'open', assignee: '',
  contextCount: 0, progress: null, projectPageId: 'project-1',
  sessions: [{
    agentSessionId: 'session-1', displayName: '이전 세션', status: 'completed',
    sessionType: null, agentId: 'agent', nodeId: 'node', folderId: null,
    predecessorSessionId: null,
    reviewState: 'acknowledged', createdAt: '', updatedAt: '',
  }],
  sessionIds: ['session-1'],
} as PlannerFolder;
