import { useAuthStore } from '../../store/authStore';
import { useSessionStore } from '../../store/sessionStore';
import { useSettingsStore } from '../../store/settingsStore';
import { useUIStore } from '../../store/uiStore';

const mockApi = {
  getSessionsByIds: jest.fn(),
  listCards: jest.fn(),
};
const mockOpenPlannerSessionWorkspace = jest.fn();
const mockCancelPlannerSessionWorkspaceOpen = jest.fn();

jest.mock('../../api/client', () => ({
  createApiClient: jest.fn(() => mockApi),
}));
jest.mock('../planner-folder-workspace', () => ({
  cancelPlannerSessionWorkspaceOpen: () => mockCancelPlannerSessionWorkspaceOpen(),
  openPlannerSessionWorkspace: (...args: unknown[]) => mockOpenPlannerSessionWorkspace(...args),
}));

import { openFeedSessionCardWorkspace } from '../session-feed-card-workspace';

beforeEach(() => {
  jest.clearAllMocks();
  useSettingsStore.setState({ serverUrl: 'https://feed.test' });
  useAuthStore.setState({ jwt: 'feed-jwt' });
  useSessionStore.setState({ sessions: {} });
  useUIStore.setState({
    selectedCardId: null,
    initialCardSessionId: null,
    selectedFolderPageId: null,
    folderOverlayVisible: false,
    activeSessionId: null,
    focusEventId: null,
    sessionFolderResolution: null,
  });
  mockApi.getSessionsByIds.mockImplementation(async (ids: string[]) => [{
    agentSessionId: ids[0], cardId: null, folderId: 'folder-1', displayName: ids[0],
  }]);
  mockApi.listCards.mockResolvedValue({ cards: [] });
  mockOpenPlannerSessionWorkspace.mockResolvedValue(true);
});

test('피드 세션의 cardId를 먼저 사용해 선택한 소속 세션과 함께 카드를 연다', async () => {
  mockApi.getSessionsByIds.mockResolvedValue([{
    agentSessionId: 'feed-child', cardId: 'card-1', folderId: 'folder-1',
  }]);

  await expect(openFeedSessionCardWorkspace('feed-child')).resolves.toBe(true);

  expect(mockApi.listCards).not.toHaveBeenCalled();
  expect(useUIStore.getState()).toMatchObject({
    selectedCardId: 'card-1',
    initialCardSessionId: 'feed-child',
    activeSessionId: 'feed-child',
    folderOverlayVisible: true,
  });
  expect(mockOpenPlannerSessionWorkspace).not.toHaveBeenCalled();
  expect(mockCancelPlannerSessionWorkspaceOpen).toHaveBeenCalledTimes(1);
});

test('새 feed 선택은 느린 이전 폴더 열기를 먼저 취소한다', async () => {
  const order: string[] = [];
  mockCancelPlannerSessionWorkspaceOpen.mockImplementation(() => order.push('cancel'));
  mockApi.getSessionsByIds.mockImplementation(async (ids: string[]) => {
    order.push('resolve-session');
    return [{ agentSessionId: ids[0], cardId: 'card-new', folderId: 'folder-1' }];
  });

  await openFeedSessionCardWorkspace('feed-new');

  expect(order).toEqual(['cancel', 'resolve-session']);
  expect(useUIStore.getState()).toMatchObject({
    selectedCardId: 'card-new',
    activeSessionId: 'feed-new',
  });
});

test('cardId가 없으면 완료 카드도 포함한 목록에서 담당 세션 관계를 찾는다', async () => {
  mockApi.listCards.mockResolvedValue({ cards: [
    { id: 'card-1', assigneeSessionId: 'feed-owner' },
  ] });

  await openFeedSessionCardWorkspace('feed-owner');

  expect(mockApi.listCards).toHaveBeenCalledWith(undefined, { includeCompleted: true });
  expect(useUIStore.getState()).toMatchObject({
    selectedCardId: 'card-1',
    initialCardSessionId: 'feed-owner',
    activeSessionId: 'feed-owner',
  });
  expect(mockOpenPlannerSessionWorkspace).not.toHaveBeenCalled();
});

test('카드가 없는 폴더 세션은 기존 folder opener로 위임한다', async () => {
  await openFeedSessionCardWorkspace('feed-folder');

  expect(useUIStore.getState().selectedCardId).toBeNull();
  expect(useUIStore.getState().initialCardSessionId).toBeNull();
  expect(mockOpenPlannerSessionWorkspace).toHaveBeenCalledWith(
    'feed-folder', undefined, undefined, 'feed',
  );
});

test('카드 목록 조회 실패는 오류 표면에 남고 미연결 세션으로 열지 않는다', async () => {
  mockApi.listCards.mockRejectedValue(new Error('카드 조회 실패'));

  await expect(openFeedSessionCardWorkspace('feed-folder')).resolves.toBe(false);

  expect(mockOpenPlannerSessionWorkspace).not.toHaveBeenCalled();
  expect(useUIStore.getState()).toMatchObject({
    selectedCardId: null,
    sessionFolderResolution: {
      sessionId: 'feed-folder',
      status: 'error',
      retryable: false,
    },
  });
});

test('이전 카드 목록 응답은 더 최근 feed 선택을 덮지 않는다', async () => {
  let resolveCards!: (value: { cards: never[] }) => void;
  mockApi.getSessionsByIds.mockImplementation(async (ids: string[]) => [{
    agentSessionId: ids[0], cardId: ids[0] === 'new-feed' ? 'new-card' : null,
    folderId: 'folder-1',
  }]);
  mockApi.listCards.mockReturnValue(new Promise((resolve) => { resolveCards = resolve; }));

  const oldRequest = openFeedSessionCardWorkspace('old-feed');
  await Promise.resolve();
  const newRequest = openFeedSessionCardWorkspace('new-feed');
  await expect(newRequest).resolves.toBe(true);
  resolveCards({ cards: [] });
  await expect(oldRequest).resolves.toBe(false);

  expect(useUIStore.getState()).toMatchObject({
    selectedCardId: 'new-card',
    activeSessionId: 'new-feed',
  });
  expect(mockOpenPlannerSessionWorkspace).not.toHaveBeenCalled();
});
