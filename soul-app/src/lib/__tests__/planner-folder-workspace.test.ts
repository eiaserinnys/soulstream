import type { PlannerFolder, PlannerToday } from '../../api/plannerTypes';
import { bindPlannerFolderScope, usePlannerStore } from '../../store/plannerStore';
import { useAuthStore } from '../../store/authStore';
import { useSessionStore } from '../../store/sessionStore';
import { useSettingsStore } from '../../store/settingsStore';
import { useUIStore } from '../../store/uiStore';
import { waitFor } from '@testing-library/react-native';
import { plannerFolderTitleSaveCoordinator } from '../planner-folder-title-save';
import { captureAuthScope } from '../auth-scope';

const mockApi = {
  getSessionsByIds: jest.fn(),
  getSessionBoardItems: jest.fn(),
  getCatalog: jest.fn(),
  getFolderBoardItems: jest.fn(),
  getPlannerFolder: jest.fn(),
  getFolderSnapshot: jest.fn(),
  getProjectFolders: jest.fn(),
  getFolderRuns: jest.fn(),
};
jest.mock('../../api/client', () => ({
  createApiClient: jest.fn(() => mockApi),
}));
jest.mock('../ui-usage-events', () => ({
  createUiUsageFlowId: jest.fn(() => 'resolution-flow'),
  recordUiUsageEvent: jest.fn(),
}));
import {
  recordCurrentPlannerUsageView,
  openPlannerFolderWorkspace,
  openPlannerSessionWorkspace,
  retryPlannerSessionWorkspace,
  openStarredPageWorkspace,
  resetPlannerSessionResolverForTest,
} from '../planner-folder-workspace';
import { recordUiUsageEvent } from '../ui-usage-events';

const folder = {
  page: { id: 'task-1' },
  folderId: 'task-1',
  sessionIds: ['session-1'],
} as PlannerFolder;

beforeEach(() => {
  jest.clearAllMocks();
  resetPlannerSessionResolverForTest();
  plannerFolderTitleSaveCoordinator.reset();
  usePlannerStore.getState().resetForTest();
  useSessionStore.setState({ sessions: {}, catalog: { folders: [], sessions: {} } });
  useSettingsStore.setState({ serverUrl: 'https://planner.test' });
  useAuthStore.setState({ jwt: 'planner-jwt' });
  bindPlannerFolderScope(folder);
  useUIStore.setState({
    selectedFolderPageId: null,
    folderOverlayVisible: false,
    activeSessionId: null,
    focusEventId: null,
    sessionFolderResolution: null,
  });
  mockApi.getSessionsByIds.mockResolvedValue([]);
  mockApi.getSessionBoardItems.mockResolvedValue([]);
  mockApi.getCatalog.mockResolvedValue({ folders: [], sessions: {} });
  mockApi.getFolderBoardItems.mockResolvedValue([]);
  mockApi.getFolderBoardItems.mockResolvedValue([]);
  mockApi.getFolderSnapshot.mockResolvedValue(null);
  mockApi.getProjectFolders.mockResolvedValue({ items: [], nextCursor: null });
  mockApi.getFolderRuns.mockResolvedValue({ items: [], nextCursor: null, total: 0 });
  mockApi.getPlannerFolder.mockReset();
});

test('Daily·Project 업무 선택은 snapshot과 첫 실행 세션을 같은 오버레이 경로로 연다', () => {
  openPlannerFolderWorkspace(folder);

  expect(usePlannerStore.getState().selectedFolderSnapshot).toBe(folder);
  expect(useUIStore.getState()).toMatchObject({
    selectedFolderPageId: 'task-1',
    folderOverlayVisible: true,
    activeSessionId: 'session-1',
  });
  expect(recordUiUsageEvent).toHaveBeenCalledWith(expect.objectContaining({
    type: 'view_open',
    target: { kind: 'folder', id: 'task-1' },
    entry: 'nav',
  }));
});

test('tablet 수집 시작 snapshot은 이미 열린 page·task·session을 from 없이 정확히 남긴다', () => {
  useUIStore.setState({
    activeSection: { kind: 'project', folderId: 'folder-1', projectPageId: 'page-1' },
  });
  recordCurrentPlannerUsageView();
  expect(recordUiUsageEvent).toHaveBeenLastCalledWith({
    type: 'view_open',
    target: { kind: 'page', id: 'page-1' },
    from: null,
    entry: 'auto',
  });

  useUIStore.setState({ selectedFolderPageId: 'task-open', activeSessionId: null });
  recordCurrentPlannerUsageView();
  expect(recordUiUsageEvent).toHaveBeenLastCalledWith(expect.objectContaining({
    target: { kind: 'page', id: 'task-open' },
    from: null,
  }));

  useUIStore.setState({ activeSessionId: 'session-open' });
  recordCurrentPlannerUsageView();
  expect(recordUiUsageEvent).toHaveBeenLastCalledWith(expect.objectContaining({
    target: { kind: 'session', id: 'session-open' },
    from: null,
  }));
});

test('tablet 업무 열기는 planner helper 한 번으로 target과 이전 화면을 함께 남긴다', () => {
  useUIStore.setState({
    activeSection: { kind: 'daily', date: '2026-09-21' },
    activeSessionId: null,
    selectedFolderPageId: null,
  });

  openPlannerFolderWorkspace(folder);

  const viewOpens = (recordUiUsageEvent as jest.Mock).mock.calls
    .map(([event]) => event)
    .filter((event) => event.type === 'view_open');
  expect(viewOpens).toEqual([expect.objectContaining({
    target: { kind: 'folder', id: 'task-1' },
    from: { kind: 'view', id: 'daily:2026-09-21' },
    entry: 'nav',
  })]);
});

test('★ 업무 선택은 pageId 읽기 표면을 열고 이전 task·chat 선택을 지운다', () => {
  usePlannerStore.getState().setSelectedFolderSnapshot(folder);
  useUIStore.setState({ activeSessionId: 'old-session' });

  openStarredPageWorkspace('starred-page');

  expect(usePlannerStore.getState().selectedFolderSnapshot).toBeNull();
  expect(useUIStore.getState()).toMatchObject({
    selectedFolderPageId: 'starred-page',
    folderOverlayVisible: true,
    activeSessionId: null,
  });
});

test('업무 전환은 이전 업무의 focus 제목을 close coordinator에 먼저 큐잉한다', async () => {
  const save = jest.fn(async () => undefined);
  let draft = '업무 전환 직전 제목';
  plannerFolderTitleSaveCoordinator.bind({
    scopeGeneration: captureAuthScope().generation,
    folder: folder,
    getDraft: () => draft,
    getServerTitle: () => '이전 서버 제목',
    save,
  });
  plannerFolderTitleSaveCoordinator.setDraft(folder.page.id, draft);
  useUIStore.setState({ selectedFolderPageId: folder.page.id, folderOverlayVisible: true });
  const nextFolder = {
    ...folder,
    page: { id: 'task-2' },
    sessionIds: ['session-2'],
  } as PlannerFolder;

  openPlannerFolderWorkspace(nextFolder);

  await waitFor(() => expect(save).toHaveBeenCalledWith(folder, '업무 전환 직전 제목'));
  expect(useUIStore.getState().selectedFolderPageId).toBe('task-2');
});

test('제목 queue는 generation+page ID로 격리되어 이전 scope의 늦은 성공이 새 scope callback을 건드리지 않는다', async () => {
  let resolveOld!: () => void;
  const oldSaved = jest.fn();
  const oldScope = captureAuthScope().generation;
  plannerFolderTitleSaveCoordinator.bind({
    scopeGeneration: oldScope,
    folder: folder,
    getDraft: () => '이전 계정 제목',
    getServerTitle: () => '이전 서버 제목',
    save: () => new Promise<void>((resolve) => { resolveOld = resolve; }),
    onSaved: oldSaved,
  });
  plannerFolderTitleSaveCoordinator.enqueueLatest(folder.page.id, oldScope);

  useAuthStore.getState().setJwt('scope-b-jwt');
  const newScope = captureAuthScope().generation;
  const newSave = jest.fn(async () => undefined);
  plannerFolderTitleSaveCoordinator.bind({
    scopeGeneration: newScope,
    folder: folder,
    getDraft: () => '새 계정 제목',
    getServerTitle: () => '새 서버 제목',
    save: newSave,
  });
  plannerFolderTitleSaveCoordinator.enqueueLatest(folder.page.id, newScope);

  await waitFor(() => expect(newSave).toHaveBeenCalledWith(folder, '새 계정 제목'));
  resolveOld();
  await Promise.resolve();
  expect(oldSaved).not.toHaveBeenCalled();
});

test('세션 선택은 캐시된 소속 업무가 있으면 업무 문맥과 함께 연다', () => {
  openPlannerFolderWorkspace(folder);
  usePlannerStore.getState().setDaily('2026-07-17', {
    folders: [folder],
  } as PlannerToday);

  openPlannerSessionWorkspace('session-1');

  expect(usePlannerStore.getState().selectedFolderSnapshot).toBe(folder);
  expect(useUIStore.getState()).toMatchObject({
    selectedFolderPageId: 'task-1',
    folderOverlayVisible: true,
    activeSessionId: 'session-1',
  });
  expect(recordUiUsageEvent).toHaveBeenCalledWith(expect.objectContaining({
    type: 'view_open',
    target: { kind: 'session', id: 'session-1' },
  }));
  expect(recordUiUsageEvent).toHaveBeenCalledWith({
    type: 'action_start',
    target: { kind: 'session', id: 'session-1' },
    entry: 'nav',
    flowId: 'resolution-flow',
    attrs: { action: 'session_resolution' },
  });
});

test('같은 sessionId라도 인증 scope가 바뀌면 이전 planner projection cache를 재사용하지 않는다', () => {
  openPlannerFolderWorkspace(folder);
  usePlannerStore.getState().setDaily('2026-07-17', { folders: [folder] } as PlannerToday);
  openPlannerSessionWorkspace('session-1');
  expect(usePlannerStore.getState().selectedFolderSnapshot).toBe(folder);

  useAuthStore.setState({ jwt: 'other-account-jwt' });
  usePlannerStore.getState().setDaily('2026-07-18', {
    folders: [{ ...folder, page: { id: 'other-task' }, sessionIds: ['other-session'] }],
  } as PlannerToday);
  openPlannerSessionWorkspace('session-1');

  expect(usePlannerStore.getState().selectedFolderSnapshot).toBeNull();
  expect(useUIStore.getState().sessionFolderResolution).toEqual({
    sessionId: 'session-1',
    status: 'loading',
  });
});

test('scope 전환 직후 이전 화면의 업무 카드를 탭해도 새 scope store나 resolver를 prime하지 않는다', () => {
  usePlannerStore.getState().setDaily('2026-07-17', { folders: [folder] } as PlannerToday);
  const previousFolder = usePlannerStore.getState().dailyByDate['2026-07-17']!.folders[0];
  useUIStore.setState({ selectedFolderPageId: null, folderOverlayVisible: false });

  useAuthStore.getState().setJwt('scope-b-jwt');
  openPlannerFolderWorkspace(previousFolder);

  expect(usePlannerStore.getState().selectedFolderSnapshot).toBeNull();
  expect(useUIStore.getState()).toMatchObject({
    selectedFolderPageId: null,
    folderOverlayVisible: false,
  });
});

test('세션 cache miss는 서버 확인 전 중립 loading 오버레이를 연다', () => {
  usePlannerStore.getState().setSelectedFolderSnapshot(folder);

  openPlannerSessionWorkspace('orphan-session');

  expect(usePlannerStore.getState().selectedFolderSnapshot).toBeNull();
  expect(useUIStore.getState()).toMatchObject({
    selectedFolderPageId: null,
    folderOverlayVisible: true,
    activeSessionId: 'orphan-session',
    sessionFolderResolution: { sessionId: 'orphan-session', status: 'loading' },
  });
});

test('tablet linked-task 재시도는 원래 검색 intent ID를 성공 UI까지 보존한다', async () => {
  const session = {
    agentSessionId: 'retry-session',
    displayName: '재시도 세션',
    folderId: null,
    status: 'completed',
    createdAt: '2026-07-18T00:00:00Z',
    updatedAt: '2026-07-18T01:00:00Z',
  };
  mockApi.getSessionsByIds
    .mockRejectedValueOnce(new Error('temporary failure'))
    .mockResolvedValueOnce([session]);
  mockApi.getSessionBoardItems.mockResolvedValue([]);

  await expect(openPlannerSessionWorkspace(
    'retry-session',
    42,
    undefined,
    'search',
    73,
  )).resolves.toBe(false);
  expect(useUIStore.getState().sessionSearchIntentId).toBe(73);

  retryPlannerSessionWorkspace('retry-session', 42);

  await waitFor(() => expect(useUIStore.getState()).toMatchObject({
    sessionFolderResolution: { sessionId: 'retry-session', status: 'unlinked' },
    sessionSearchIntentId: 73,
    completedSessionSearchIntentId: 73,
  }));
});

test('cache miss linked session은 folderId로 폴더 aggregate를 읽어 업무+채팅을 연다', async () => {
  const linkedSession = {
    agentSessionId: 'linked-cold', displayName: '연결 세션', folderId: 'task-1',
    status: 'completed', createdAt: '2026-07-18T00:00:00Z',
    updatedAt: '2026-07-18T01:00:00Z',
  };
  mockApi.getSessionsByIds.mockResolvedValue([linkedSession]);
  mockApi.getPlannerFolder.mockResolvedValue({
    folder: {
      id: 'task-1', name: '연결 업무', projectPageId: 'task-page-1',
      parentFolderId: null, sortOrder: 0, settings: {}, archived: false,
      status: 'open', version: 1,
    },
    page: {
      id: 'task-page-1', title: '연결 업무', dailyDate: null, version: 1,
      archived: false, metadata: {}, createdAt: '', updatedAt: '',
    },
    blocks: [], cards: [],
    subfolders: { items: [], nextCursor: null },
    sessions: { items: [], nextCursor: null },
  });

  openPlannerSessionWorkspace('linked-cold', 31, 77);

  await waitFor(() => expect(useUIStore.getState()).toMatchObject({
    selectedFolderPageId: 'task-page-1',
    activeSessionId: 'linked-cold',
    focusEventId: 31,
    storyOpenRequestId: 77,
    sessionFolderResolution: null,
  }));
  expect(usePlannerStore.getState().selectedFolderSnapshot).toMatchObject({
    page: { id: 'task-page-1', title: '연결 업무' },
    folderId: 'task-1', sessionIds: ['linked-cold'],
  });
  expect(mockApi.getSessionsByIds).toHaveBeenCalledWith(['linked-cold']);
  expect(mockApi.getPlannerFolder).toHaveBeenCalledWith('task-1',{includeCompleted:false});
  expect(mockApi.getSessionBoardItems).not.toHaveBeenCalled();
  expect(mockApi.getCatalog).not.toHaveBeenCalled();
});

test('direct membership이 없는 세션만 unlinked로 열고 catalog를 읽지 않는다', async () => {
  mockApi.getSessionsByIds.mockResolvedValue([{
    agentSessionId: 'session-only',
    displayName: '독립 세션',
    folderId: null,
    status: 'completed',
    createdAt: '2026-07-18T00:00:00Z',
    updatedAt: '2026-07-18T01:00:00Z',
  }]);
  mockApi.getSessionBoardItems.mockResolvedValue([]);

  await expect(openPlannerSessionWorkspace('session-only', null, 88))
    .resolves.toBe(true);

  await waitFor(() => expect(useUIStore.getState()).toMatchObject({
    activeSessionId: 'session-only',
    selectedFolderPageId: null,
    storyOpenRequestId: 88,
    sessionFolderResolution: { sessionId: 'session-only', status: 'unlinked' },
  }));
  expect(mockApi.getCatalog).not.toHaveBeenCalled();
});

test('보관된 연결 폴더는 재시도 불가 오류로 표시한다', async () => {
  mockApi.getSessionsByIds.mockResolvedValue([{
    agentSessionId: 'archived-session', displayName: '보관 세션', folderId: 'archived-folder',
    status: 'completed', createdAt: '2026-07-18T00:00:00Z', updatedAt: '2026-07-18T01:00:00Z',
  }]);
  mockApi.getPlannerFolder.mockResolvedValue({ folder: { id: 'archived-folder', archived: true } });

  await expect(openPlannerSessionWorkspace('archived-session', null, 99)).resolves.toBe(false);
  await waitFor(() => expect(useUIStore.getState()).toMatchObject({
    activeSessionId: 'archived-session', selectedFolderPageId: null,
    storyOpenRequestId: 99,
    sessionFolderResolution: {
      sessionId: 'archived-session', status: 'error',
      message: '연결된 폴더는 보관되어 열 수 없습니다.', retryable: false,
    },
  }));
  expect(mockApi.getCatalog).not.toHaveBeenCalled();
});
