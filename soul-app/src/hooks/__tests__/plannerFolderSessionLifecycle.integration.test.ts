import { act, renderHook } from '@testing-library/react-native';
import type { ApiClient } from '../../api/client';
import type { PlannerFolderCollection, PlannerFolder, PlannerToday } from '../../api/plannerTypes';
import { resolveFolderRunSession } from '../../components/planner/FolderSessionHistory';
import { resetAuthScopeForTest } from '../../lib/auth-scope';
import { useAuthStore } from '../../store/authStore';
import { usePlannerStore } from '../../store/plannerStore';
import { useSessionStore } from '../../store/sessionStore';
import { useSettingsStore } from '../../store/settingsStore';
import { createPlannerActions } from '../usePlannerActions';
import { useSessionsStream } from '../useSessionsStream';

let mockStreamOptions: { onEvent(type: string, data: unknown): void } | null = null;

jest.mock('../../api/client', () => ({
  createApiClient: () => ({
    getCatalog: () => new Promise(() => {}),
    catalogStreamUrl: () => 'https://planner.test/api/sessions/stream',
  }),
}));

jest.mock('../useSSEStream', () => ({
  CATALOG_STREAM_EVENTS: ['session_updated'],
  useSSEStream: (options: { onEvent(type: string, data: unknown): void }) => {
    mockStreamOptions = options;
  },
}));

const folderPage = {
  id: 'task-page-1', title: '열린 업무', dailyDate: null, version: 1,
  archived: false, metadata: {}, createdAt: '', updatedAt: '',
};
const folder: PlannerFolder = {
  page: folderPage,
  blocks: [],
  folderId: 'task-1',
  folderSummary: {
    id: 'task-1', title: '열린 업무', status: 'open',
    archived: false, version: 1, itemCounts: {}, itemTotal: 0,
    completedItemCount: 0, assignee: null,
  },
  status: 'open', assignee: '', contextCount: 0, progress: null,
  projectPageId: 'project-1', sessions: [], sessionIds: [],
};
const today: PlannerToday = {
  daily: {
    page: { ...folderPage, id: 'daily-1', title: '오늘' },
    blocks: [],
    stateVector: 'sv',
  },
  projects: [], memoBlocks: [], folders: [folder], attention: [], running: [], queued: [], reviewSessionIds: [],
};
const project: PlannerFolderCollection = {
  project: { ...folderPage, id: 'project-1', title: '프로젝트' },
  folders: { items: [folder], nextCursor: null },
};

beforeEach(() => {
  mockStreamOptions = null;
  useSettingsStore.setState({ serverUrl: 'https://planner.test' });
  useAuthStore.setState({ jwt: 'scope-a-jwt' });
  resetAuthScopeForTest();
  usePlannerStore.getState().resetForTest();
  usePlannerStore.setState({
    dailyByDate: { '2026-07-19': today },
    folderByPageId: { 'project-1': project },
    folderChildPages: { 'project-1': project.folders },
    folderSessionPages: {
      [folderPage.id]: { items: [], nextCursor: null },
    },
    selectedFolderSnapshot: folder,
  });
  useSessionStore.setState({
    sessions: {},
    catalog: { folders: [], sessions: {} },
    catalogReady: false,
    feedSessionIds: [],
    sessionChangeSerial: 0,
    lastChangedSessionId: null,
  });
});

test('업무 실행 세션 생성과 completed 갱신은 open 업무와 session tree/run history 연결을 유지한다', async () => {
  const response = {
    agentSessionId: 'session-new',
    displayName: null,
    nodeId: 'node-a',
    sessionType: 'interactive',
    status: 'pending',
  };
  const createFolderSession = jest.fn().mockResolvedValue(response);
  const api = { plannerMutations: { createFolderSession } } as unknown as ApiClient;

  await createPlannerActions(api).createFolderSession({
    folder: folder,
    prompt: '업무를 실행해줘',
    needsPageAnchor: false,
    attachmentPaths: ['/uploads/image-a.png'],
  });

  expect(createFolderSession).toHaveBeenCalledWith(expect.objectContaining({
    folder: folder,
    attachmentPaths: ['/uploads/image-a.png'],
  }));
  assertOpenFolderRemainsLinked('session-new');
  expect(useSessionStore.getState().sessions['session-new']).toMatchObject({ status: 'pending' });

  const { unmount } = renderHook(() => useSessionsStream());
  act(() => mockStreamOptions?.onEvent('session_updated', {
    agent_session_id: 'session-new',
    status: 'completed',
    updated_at: '2026-07-19T01:00:00Z',
  }));

  assertOpenFolderRemainsLinked('session-new');
  const completed = useSessionStore.getState().sessions['session-new'];
  expect(completed).toMatchObject({ status: 'completed' });
  const plannerSummary = usePlannerStore.getState().selectedFolderSnapshot?.sessions[0];
  expect(resolveFolderRunSession('session-new', plannerSummary, completed).status).toBe('completed');
  unmount();
});

function assertOpenFolderRemainsLinked(sessionId: string): void {
  const state = usePlannerStore.getState();
  for (const current of [
    state.dailyByDate['2026-07-19']?.folders[0],
    state.folderChildPages['project-1']?.items[0],
    state.folderByPageId['project-1']?.folders.items[0],
    state.selectedFolderSnapshot,
  ]) {
    expect(current).toMatchObject({
      status: 'open',
      folderSummary: { status: 'open' },
      sessionIds: [sessionId],
      sessions: [expect.objectContaining({ agentSessionId: sessionId })],
    });
  }
  expect(state.folderSessionPages[folderPage.id]).toMatchObject({
    items: [{ agentSessionId: sessionId }],
  });
}
