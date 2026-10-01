import type { ApiClient } from '../../api/client';
import { useSessionStore } from '../../store/sessionStore';
import { useUIStore } from '../../store/uiStore';
import { usePlannerStore } from '../../store/plannerStore';
import { createPlannerCatalogActions } from '../plannerCatalogActions';
import { useAuthStore } from '../../store/authStore';
import { useSettingsStore } from '../../store/settingsStore';
import { captureAuthScope, resetAuthScopeForTest } from '../../lib/auth-scope';

beforeEach(() => {
  useSettingsStore.setState({ serverUrl: 'https://planner.test' });
  useAuthStore.setState({ jwt: 'scope-a' });
  resetAuthScopeForTest();
  usePlannerStore.getState().resetForTest();
  usePlannerStore.setState({
    folderByPageId: {
      'page-1': {
        project: {
          id: 'page-1', title: '프로젝트', dailyDate: null, version: 1,
          archived: false, metadata: {}, createdAt: '', updatedAt: '',
        },
        folders: { items: [], nextCursor: null },
      },
    },
    folderChildPages: { 'page-1': { items: [], nextCursor: null } },
  });
  useSessionStore.setState({
    catalog: {
      folders: [{ id: 'folder-1', name: '프로젝트', sortOrder: 0, projectPageId: 'page-1' }],
      sessions: {},
    },
    catalogReady: true,
  });
  useUIStore.setState({
    todayDate: '2026-07-17',
    activeSection: { kind: 'project', folderId: 'folder-1', projectPageId: 'page-1' },
  });
});

test('프로젝트 삭제 성공은 catalog와 현재 navigation을 함께 패치한다', async () => {
  const archiveFolder = jest.fn().mockResolvedValue({ ok: true });
  const api = { plannerMutations: { archiveFolder } } as unknown as ApiClient;
  const actions = createPlannerCatalogActions(() => api);

  await actions.archiveFolder('folder-1', 1);

  expect(useSessionStore.getState().catalog.folders).toEqual([expect.objectContaining({ id: 'folder-1', archived: true })]);
  expect(useUIStore.getState().activeSection).toEqual({ kind: 'daily', date: '2026-07-17' });
  expect(usePlannerStore.getState().folderByPageId['page-1']).toBeUndefined();
  expect(usePlannerStore.getState().folderChildPages['page-1']).toBeUndefined();
});

test('프로젝트 삭제 실패는 catalog와 navigation before를 정확히 복원한다', async () => {
  const beforeCatalog = useSessionStore.getState().catalog;
  const beforeSection = useUIStore.getState().activeSection;
  const beforeProjects = usePlannerStore.getState().folderByPageId;
  const beforeFolders = usePlannerStore.getState().folderChildPages;
  const archiveFolder = jest.fn().mockRejectedValue(new Error('failed'));
  const api = { plannerMutations: { archiveFolder } } as unknown as ApiClient;
  const actions = createPlannerCatalogActions(() => api);

  await expect(actions.archiveFolder('folder-1', 1)).rejects.toThrow('failed');

  expect(useSessionStore.getState().catalog).toBe(beforeCatalog);
  expect(useUIStore.getState().activeSection).toBe(beforeSection);
  expect(usePlannerStore.getState().folderByPageId).toBe(beforeProjects);
  expect(usePlannerStore.getState().folderChildPages).toBe(beforeFolders);
});

test('프로젝트 이름 변경은 catalog와 읽어 둔 project page를 함께 패치한다', async () => {
  const renameFolder = jest.fn().mockResolvedValue({ ok: true });
  const api = { plannerMutations: { renameFolder } } as unknown as ApiClient;

  await createPlannerCatalogActions(() => api).renameFolder('folder-1', '새 이름');

  expect(useSessionStore.getState().catalog.folders[0]?.name).toBe('새 이름');
  expect(usePlannerStore.getState().folderByPageId['page-1']?.project.title).toBe('새 이름');
});

test.each([
  ['create', 'success'],
  ['create', 'failure'],
  ['rename', 'success'],
  ['rename', 'failure'],
  ['delete', 'success'],
  ['delete', 'failure'],
] as const)(
  'scope 전환 뒤 이전 project %s %s settle은 새 catalog를 patch/restore하지 않는다',
  async (operation, outcome) => {
    let resolveMutation!: (value: any) => void;
    let rejectMutation!: (cause: unknown) => void;
    const mutation = new Promise<any>((resolve, reject) => {
      resolveMutation = resolve;
      rejectMutation = reject;
    });
    const plannerMutations = {
      createRootFolder: jest.fn(() => mutation),
      renameFolder: jest.fn(() => mutation),
      archiveFolder: jest.fn(() => mutation),
    };
    const api = { plannerMutations } as unknown as ApiClient;
    const oldGeneration = captureAuthScope().generation;
    const actions = createPlannerCatalogActions(() => api, oldGeneration);
    const pending = operation === 'create'
      ? actions.createRootFolder('이전 생성')
      : operation === 'rename'
        ? actions.renameFolder('folder-1', '이전 이름')
        : actions.archiveFolder('folder-1', 1);

    useAuthStore.getState().setJwt('scope-b');
    const nextCatalog = {
      folders: [{ id: 'folder-1', name: '새 계정 프로젝트', sortOrder: 0, projectPageId: 'page-1' }],
      sessions: {},
    };
    useSessionStore.setState({ catalog: nextCatalog, catalogReady: true });

    if (outcome === 'success') {
      resolveMutation(operation === 'create'
        ? { id: 'created-old', name: '이전 생성', sortOrder: 0 }
        : { ok: true });
      await expect(pending).resolves.toBeDefined();
    } else {
      rejectMutation(new Error('old scope failed'));
      await expect(pending).rejects.toThrow('old scope failed');
    }

    expect(useSessionStore.getState().catalog).toBe(nextCatalog);
  },
);
