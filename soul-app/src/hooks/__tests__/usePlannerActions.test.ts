import type { ApiClient } from '../../api/client';
import type { PlannerFolder, PlannerToday } from '../../api/plannerTypes';
import { createPlannerActions } from '../usePlannerActions';
import { usePlannerStore } from '../../store/plannerStore';
import { useAuthStore } from '../../store/authStore';
import { useSettingsStore } from '../../store/settingsStore';
import { captureAuthScope } from '../../lib/auth-scope';
import { useSessionStore } from '../../store/sessionStore';
import { ApiHttpError } from '../../api/clientCore';

jest.mock('expo-crypto', () => ({ randomUUID: jest.fn(() => 'request-id') }));

const page = {
  id: 'task-1', title: '기존 업무', dailyDate: null, version: 1,
  archived: false, metadata: {}, createdAt: '', updatedAt: '',
};
const folder: PlannerFolder = {
  page,
  blocks: [],
  folderId: 'task-1',
  folderSummary: null,
  status: 'open', assignee: '', contextCount: 0, progress: null,
  projectPageId: 'project-1', sessions: [], sessionIds: [],
};
const daily: PlannerToday = {
  daily: { page: { ...page, id: 'daily' }, blocks: [], stateVector: 'sv' },
  projects: [], memoBlocks: [], folders: [folder], attention: [], running: [], queued: [], reviewSessionIds: [],
};

beforeEach(() => {
  useSettingsStore.setState({ serverUrl: 'https://planner.test' });
  useAuthStore.setState({ jwt: 'scope-a-jwt' });
  usePlannerStore.getState().resetForTest();
  useSessionStore.setState({ sessions: {}, catalog: { folders: [], sessions: {} } });
  usePlannerStore.setState({
    dailyByDate: {
      '2026-07-17': daily,
      '2026-07-16': { ...daily, folders: [] },
    },
    folderChildPages: { 'project-1': { items: [folder], nextCursor: null } },
    selectedFolderSnapshot: folder,
  });
});

test('오늘 제거 실패는 낙관 membership을 원래 snapshot으로 복원한다', async () => {
  let rejectMutation!: (error: unknown) => void;
  const mutation = new Promise<never>((_, reject) => { rejectMutation = reject; });
  const setFolderToday = jest.fn(() => mutation);
  const api = { plannerMutations: { setFolderToday } } as unknown as ApiClient;

  const pending = createPlannerActions(api).setFolderToday(folder, '2026-07-17', false);
  expect(usePlannerStore.getState().dailyByDate['2026-07-17']?.folders).toEqual([]);

  rejectMutation(new Error('daily failed'));
  await expect(pending).rejects.toThrow('daily failed');
  expect(usePlannerStore.getState().dailyByDate['2026-07-17']?.folders).toEqual([folder]);
});

test('폴더 생성은 한 경로를 사용하고 카탈로그에 반영한다', async () => {
  const created = { id: 'new-folder', name: '자료실', parentFolderId: 'parent', projectPageId: 'parent-page', version: 1, sortOrder: 0 };
  const createFolder = jest.fn().mockResolvedValue({ folder: created });
  const api = { plannerMutations: { createFolder } } as unknown as ApiClient;
  await createPlannerActions(api).createFolder({
    title: '자료실', folderId: 'parent', projectPageId: 'parent-page',
  });
  expect(createFolder.mock.calls[0][0]).toEqual({
    title: '자료실', description: '', folderId: 'parent', projectPageId: 'parent-page',
  });
  expect(useSessionStore.getState().catalog.folders).toContainEqual(created);
});

test('중요 지정 실패는 낙관 starred 상태를 복원하고 page 한 건만 재조회한다', async () => {
  let rejectMutation!: (error: unknown) => void;
  const mutation = new Promise<never>((_, reject) => { rejectMutation = reject; });
  const setFolderStarred = jest.fn(() => mutation);
  const getPage = jest.fn().mockResolvedValue({ page, blocks: [], stateVector: 'sv' });
  const api = {
    getPage,
    plannerMutations: { setFolderStarred },
  } as unknown as ApiClient;

  const pending = createPlannerActions(api).setFolderStarred(folder, true);
  expect(usePlannerStore.getState().selectedFolderSnapshot?.page.metadata.starred).toBe(true);

  rejectMutation(new Error('star failed'));
  await expect(pending).rejects.toThrow('star failed');
  expect(usePlannerStore.getState().selectedFolderSnapshot?.page.metadata.starred).toBeUndefined();
  expect(getPage).toHaveBeenCalledTimes(1);
  expect(getPage).toHaveBeenCalledWith('task-1');
});

test('세션 업무 이동은 projection page ID와 서버 canonical task ID를 분리한다', async () => {
  const moveFolderSession = jest.fn().mockResolvedValue({});
  const api = { plannerMutations: { moveFolderSession } } as unknown as ApiClient;
  const target = {
    ...folder,
    page: { ...folder.page, id: 'task-page-2', title: '대상 업무' },
    folderId: 'canonical-task-2',
  };

  await createPlannerActions(api).moveFolderSession('session-1', target);

  expect(moveFolderSession).toHaveBeenCalledWith('session-1', 'canonical-task-2');
});

test('page anchor 재시도 성공 뒤 세션 POST로 이어진다', async () => {
  const anchor = { pageId: 'task-1', blockId: 'anchor-1', expectedVersion: 3 };
  const createPageAnchor = jest.fn().mockResolvedValue(anchor);
  const createFolderSession = jest.fn().mockResolvedValue({ agentSessionId: 'session-1' });
  const api = {
    plannerMutations: { createPageAnchor, createFolderSession },
  } as unknown as ApiClient;

  await createPlannerActions(api).createFolderSession({ folder: folder, prompt: '계속 진행' });

  expect(createPageAnchor).toHaveBeenCalledWith('task-1');
  expect(createFolderSession).toHaveBeenCalledWith(expect.objectContaining({
    folder: folder,
    prompt: '계속 진행',
    pageAnchor: anchor,
  }));
});

test('page anchor의 두 번째 409가 표면화되면 세션 POST를 실행하지 않는다', async () => {
  const secondConflict = new ApiHttpError('second conflict', 409, JSON.stringify({
    detail: { error: { code: 'PAGE_MUTATION_VERSION_CONFLICT' } },
  }));
  const createFolderSession = jest.fn();
  const api = {
    plannerMutations: {
      createPageAnchor: jest.fn().mockRejectedValue(secondConflict),
      createFolderSession,
    },
  } as unknown as ApiClient;
  const sessionsBefore = useSessionStore.getState().sessions;

  await expect(createPlannerActions(api).createFolderSession({ folder: folder, prompt: '계속 진행' }))
    .rejects.toBe(secondConflict);

  expect(createFolderSession).not.toHaveBeenCalled();
  expect(useSessionStore.getState().sessions).toBe(sessionsBefore);
});

test.each(['success', 'failure'] as const)(
  'scope 전환 뒤 이전 createFolderSession %s settle은 새 session store를 patch/restore하지 않는다',
  async (outcome) => {
    let resolveMutation!: (value: { agentSessionId: string }) => void;
    let rejectMutation!: (cause: unknown) => void;
    const mutation = new Promise<{ agentSessionId: string }>((resolve, reject) => {
      resolveMutation = resolve;
      rejectMutation = reject;
    });
    const api = {
      plannerMutations: { createFolderSession: jest.fn(() => mutation) },
    } as unknown as ApiClient;
    const oldGeneration = captureAuthScope().generation;
    const pending = createPlannerActions(api, oldGeneration).createFolderSession({
      folder: folder,
      prompt: '이전 계정 세션',
      needsPageAnchor: false,
    });
    expect(Object.keys(useSessionStore.getState().sessions)).toHaveLength(1);

    useAuthStore.getState().setJwt('scope-b-jwt');
    const newSession = {
      agentSessionId: 'same-session', displayName: '새 계정 세션', status: 'idle',
      createdAt: '', updatedAt: '',
    } as any;
    useSessionStore.getState().upsertSession(newSession);

    if (outcome === 'success') resolveMutation({ agentSessionId: 'old-real-session' });
    else rejectMutation(new Error('old scope failed'));
    await expect(pending).rejects.toThrow();

    expect(useSessionStore.getState().sessions).toEqual({ 'same-session': newSession });
  },
);
