import { useUIStore } from '../uiStore';

beforeEach(() => {
  useUIStore.setState({
    selectedCardId: null,
    settingsVisible: false,
    selectedFolderPageId: null,
    folderOverlayVisible: false,
    activeSessionId: null,
    focusEventId: null,
    storyOpenRequestId: null,
    sessionFolderResolution: null,
    sessionSearchIntentId: null,
  });
});

test('iPad 설정 모달은 사이드바와 딥링크가 공유하는 단일 상태로 열고 닫힌다', () => {
  useUIStore.getState().openSettings();
  expect(useUIStore.getState().settingsVisible).toBe(true);

  useUIStore.getState().closeSettings();
  expect(useUIStore.getState().settingsVisible).toBe(false);
});

test('업무 오버레이는 pageId와 표시 상태를 한 동작으로 열고 닫는다', () => {
  useUIStore.getState().openFolderOverlay('task-page-1');

  expect(useUIStore.getState()).toMatchObject({
    selectedFolderPageId: 'task-page-1',
    folderOverlayVisible: true,
  });

  useUIStore.getState().closeFolderOverlay();

  expect(useUIStore.getState()).toMatchObject({
    selectedFolderPageId: 'task-page-1',
    folderOverlayVisible: false,
  });
});

test('업무와 함께 세션을 열면 기존 ChatPane 정본 상태를 같이 갱신한다', () => {
  useUIStore.getState().openFolderOverlay('task-page-2', 'session-2');

  expect(useUIStore.getState()).toMatchObject({
    selectedFolderPageId: 'task-page-2',
    folderOverlayVisible: true,
    activeSessionId: 'session-2',
    focusEventId: null,
    sessionFolderResolution: null,
  });
});

test('검색의 스토리 열기 요청은 연결 업무 오버레이까지 보존한다', () => {
  const openFolderOverlay = useUIStore.getState().openFolderOverlay as unknown as (
    pageId: string,
    sessionId?: string | null,
    eventId?: number | null,
    storyOpenRequestId?: number | null,
  ) => void;

  openFolderOverlay('task-page-story', 'session-story', 21, 9);

  expect(useUIStore.getState()).toMatchObject({
    selectedFolderPageId: 'task-page-story',
    activeSessionId: 'session-story',
    focusEventId: 21,
    storyOpenRequestId: 9,
  });
});

test('서버가 미소속으로 확정한 세션만 unlinked 단독 오버레이로 연다', () => {
  useUIStore.setState({ selectedFolderPageId: 'old-task' });

  useUIStore.getState().openSessionOverlay('session-only', 42);

  expect(useUIStore.getState()).toMatchObject({
    selectedFolderPageId: null,
    folderOverlayVisible: true,
    activeSessionId: 'session-only',
    focusEventId: 42,
    sessionFolderResolution: { sessionId: 'session-only', status: 'unlinked' },
  });
});

test('스토리 검색 결과는 iPad 채팅 오버레이에 외부 열기 요청을 보존한다', () => {
  useUIStore.getState().openSessionOverlay('session-only', null, 9);

  expect(useUIStore.getState()).toMatchObject({
    activeSessionId: 'session-only',
    focusEventId: null,
    storyOpenRequestId: 9,
  });
});

test('cache miss 조회·실패는 unlinked와 별도 상태로 유지한다', () => {
  useUIStore.getState().openResolvingSessionOverlay('cold-session', 7);
  expect(useUIStore.getState()).toMatchObject({
    activeSessionId: 'cold-session',
    focusEventId: 7,
    sessionFolderResolution: { sessionId: 'cold-session', status: 'loading' },
  });

  useUIStore.getState().openSessionResolutionError('cold-session', 7, '앱 업데이트 필요', false);
  expect(useUIStore.getState()).toMatchObject({
    selectedFolderPageId: null,
    sessionFolderResolution: {
      sessionId: 'cold-session',
      status: 'error',
      message: '앱 업데이트 필요',
      retryable: false,
    },
  });
});

test('진행 중인 session resolution만 취소하고 해당 loading overlay를 닫는다', () => {
  useUIStore.getState().openResolvingSessionOverlay('session-a', 42, 9);

  useUIStore.getState().cancelSessionResolution('session-a');

  expect(useUIStore.getState()).toMatchObject({
    selectedFolderPageId: null,
    folderOverlayVisible: false,
    activeSessionId: null,
    focusEventId: null,
    storyOpenRequestId: null,
    sessionFolderResolution: null,
  });
});

test('다른 세션이나 이미 끝난 resolution은 취소하지 않는다', () => {
  useUIStore.getState().openResolvingSessionOverlay('session-a');
  useUIStore.getState().cancelSessionResolution('session-b');
  expect(useUIStore.getState().sessionFolderResolution).toEqual({
    sessionId: 'session-a',
    status: 'loading',
  });

  useUIStore.getState().openSessionOverlay('session-a');
  useUIStore.getState().cancelSessionResolution('session-a');
  expect(useUIStore.getState()).toMatchObject({
    folderOverlayVisible: true,
    activeSessionId: 'session-a',
    sessionFolderResolution: { sessionId: 'session-a', status: 'unlinked' },
  });
});

test('ChatBody 완료 콜백은 현재 세션과 이벤트가 일치할 때만 focus를 지운다', () => {
  useUIStore.getState().openSessionAtEvent('session-b', 7);

  useUIStore.getState().clearFocusEventId('session-a', 42);
  expect(useUIStore.getState()).toMatchObject({
    activeSessionId: 'session-b',
    focusEventId: 7,
  });

  useUIStore.getState().clearFocusEventId('session-b', 7);
  expect(useUIStore.getState().focusEventId).toBeNull();
});

test('자정이 지나면 오늘을 보고 있던 daily만 새 날짜로 이동한다', () => {
  useUIStore.setState({
    todayDate: '2026-07-17',
    activeSection: { kind: 'daily', date: '2026-07-17' },
  });

  useUIStore.getState().refreshTodayDate(new Date('2026-07-18T09:00:00+09:00'));

  expect(useUIStore.getState()).toMatchObject({
    todayDate: '2026-07-18',
    activeSection: { kind: 'daily', date: '2026-07-18' },
  });

  useUIStore.setState({ activeSection: { kind: 'daily', date: '2026-07-15' } });
  useUIStore.getState().refreshTodayDate(new Date('2026-07-19T09:00:00+09:00'));
  expect(useUIStore.getState().activeSection).toEqual({ kind: 'daily', date: '2026-07-15' });
});

test('iPad 카드는 폴더 패널 자리에 열고 오른쪽 세션과 포커스를 유지한다', () => {
  useUIStore.setState({ activeSessionId: 'right-session', focusEventId: 42 });
  useUIStore.getState().openCardOverlay('card-1');
  expect(useUIStore.getState()).toMatchObject({ selectedCardId: 'card-1', folderOverlayVisible: true, activeSessionId: 'right-session', focusEventId: 42 });
  useUIStore.getState().openFolderOverlay('folder-page');
  expect(useUIStore.getState().selectedCardId).toBeNull();
});
