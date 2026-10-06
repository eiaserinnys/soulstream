import { Alert } from 'react-native';
import {
  openPhoneChat,
  openPhoneSearch,
  openPhoneSearchSession,
  cancelPhoneSearchSessionOpen,
} from '../phoneSessionNavigation';
import { resolvePlannerSessionFolder } from '../../lib/planner-folder-workspace';

jest.mock('../../lib/planner-folder-workspace', () => ({
  resolvePlannerSessionFolder: jest.fn(),
}));

test('본문 검색 결과는 채팅 탭에 event anchor를 보존한다', () => {
  const navigate = jest.fn();
  const navigation = { getParent: () => ({ navigate }) };

  expect(openPhoneChat(navigation, 'session-1', 42)).toBe(true);
  expect(navigate).toHaveBeenCalledWith('FeedTab', {
    screen: 'Chat', initial: false,
    params: { sessionId: 'session-1', focusEventId: 42 },
  });
});

test('하이라이트·줄거리 결과는 채팅 탭에 스토리 열기 요청을 보존한다', () => {
  const navigate = jest.fn();
  const navigation = { getParent: () => ({ navigate }) };

  expect(openPhoneChat(navigation, 'session-1', undefined, 7)).toBe(true);
  expect(navigate).toHaveBeenCalledWith('FeedTab', {
    screen: 'Chat', initial: false,
    params: { sessionId: 'session-1', storyOpenRequestId: 7 },
  });
});

test('검색 진입은 새 탭이 아니라 Feed stack의 Search 화면을 연다', () => {
  const navigate = jest.fn();
  const navigation = { getParent: () => ({ navigate }) };

  expect(openPhoneSearch(navigation, '검색어')).toBe(true);
  expect(navigate).toHaveBeenCalledWith('FeedTab', {
    screen: 'Search',
    params: { initialQuery: '검색어' },
  });
});

test('linked phone search result preserves task context and exact event in chat', async () => {
  const navigate = jest.fn();
  const navigation = { getParent: () => ({ navigate }) };
  (resolvePlannerSessionFolder as jest.Mock).mockResolvedValueOnce({
    page: { id: 'resolved-task-page', title: 'Resolved task' },
  });

  await expect(openPhoneSearchSession(navigation, 'session-1', 42))
    .resolves.toBe(true);

  expect(navigate).toHaveBeenNthCalledWith(1, 'FolderTab', {
    screen: 'FolderWorkspace',
    params: {
      folderPageId: 'resolved-task-page',
      folderTitle: 'Resolved task',
    },
  });
  expect(navigate).toHaveBeenNthCalledWith(2, 'FeedTab', {
    screen: 'Chat', initial: false,
    params: { sessionId: 'session-1', focusEventId: 42 },
  });
});

test('unlinked phone search result opens the exact session without a task route', async () => {
  const navigate = jest.fn();
  const navigation = { getParent: () => ({ navigate }) };
  (resolvePlannerSessionFolder as jest.Mock).mockResolvedValueOnce(null);

  await expect(openPhoneSearchSession(navigation, 'session-2'))
    .resolves.toBe(true);

  expect(navigate).toHaveBeenCalledTimes(1);
  expect(navigate).toHaveBeenCalledWith('FeedTab', {
    screen: 'Chat', initial: false,
    params: { sessionId: 'session-2' },
  });
});

test('latest phone search selection wins while earlier task hydration is pending', async () => {
  const navigate = jest.fn();
  const navigation = { getParent: () => ({ navigate }) };
  let finishFirst!: (folder: { page: { id: string; title: string } }) => void;
  (resolvePlannerSessionFolder as jest.Mock)
    .mockReturnValueOnce(new Promise((resolve) => { finishFirst = resolve; }))
    .mockResolvedValueOnce(null);

  const first = openPhoneSearchSession(navigation, 'session-first');
  await expect(openPhoneSearchSession(navigation, 'session-latest'))
    .resolves.toBe(true);
  finishFirst({ page: { id: 'stale-task', title: 'Stale task' } });

  await expect(first).resolves.toBe(false);
  expect(navigate).toHaveBeenCalledTimes(1);
  expect(navigate).toHaveBeenCalledWith('FeedTab', {
    screen: 'Chat', initial: false,
    params: { sessionId: 'session-latest' },
  });
});

test('root session intent cancels a phone search still resolving its linked task', async () => {
  const navigate = jest.fn();
  const navigation = { getParent: () => ({ navigate }) };
  const onResolutionFailure = jest.fn();
  let finishResolution!: (folder: { page: { id: string; title: string } }) => void;
  (resolvePlannerSessionFolder as jest.Mock).mockReturnValueOnce(new Promise((resolve) => {
    finishResolution = resolve;
  }));

  const opening = openPhoneSearchSession(
    navigation,
    'session-stale',
    undefined,
    undefined,
    onResolutionFailure,
  );
  cancelPhoneSearchSessionOpen();
  finishResolution({ page: { id: 'stale-task', title: 'Stale task' } });

  await expect(opening).resolves.toBe(false);
  expect(onResolutionFailure).not.toHaveBeenCalled();
  expect(navigate).not.toHaveBeenCalled();
});

test('root can own retry UI for a linked-task resolution failure', async () => {
  const navigate = jest.fn();
  const navigation = { getParent: () => ({ navigate }) };
  const onResolutionFailure = jest.fn();
  const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  (resolvePlannerSessionFolder as jest.Mock).mockRejectedValueOnce(new Error('offline'));

  await expect(openPhoneSearchSession(
    navigation,
    'session-failed',
    undefined,
    undefined,
    onResolutionFailure,
  )).resolves.toBe(false);

  expect(onResolutionFailure).toHaveBeenCalledTimes(1);
  expect(alertSpy).not.toHaveBeenCalled();
  expect(navigate).not.toHaveBeenCalled();
  alertSpy.mockRestore();
});
