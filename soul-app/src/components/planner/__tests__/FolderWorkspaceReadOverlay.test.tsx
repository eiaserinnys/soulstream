import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import type { Session } from '../../../api/types';
import { useCardStore } from '../../../store/cardStore';
import { cardFixture } from '../../../test-support/cards';
import { usePlannerStore } from '../../../store/plannerStore';
import { useSessionStore } from '../../../store/sessionStore';
import { useUIStore } from '../../../store/uiStore';
import {
  FolderWorkspaceReadOverlay,
  resolveFolderPaneWidth,
} from '../FolderWorkspaceReadOverlay';
import { retryPlannerSessionWorkspace } from '../../../lib/planner-folder-workspace';
import { coordinateFolderWorkspaceClose } from '../../../lib/planner-folder-title-save';
import { TABLET_SHELL_LAYOUT } from '../../../theme';

jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
jest.mock('@expo/vector-icons/MaterialCommunityIcons', () => 'MaterialCommunityIcons');
jest.mock('expo-document-picker', () => ({ getDocumentAsync: jest.fn() }));
jest.mock('expo-image-picker', () => ({
  MediaTypeOptions: { Images: 'Images' },
  launchImageLibraryAsync: jest.fn(),
}));
jest.mock('react-native-webview', () => ({
  WebView: () => null,
}));

jest.mock('../CardDetailSheet', () => ({ CardDetailContent: () => require('react').createElement(require('react-native').View, { testID: 'overlay-card-detail' }) }));

jest.mock('../../split/ChatPane', () => ({
  ChatPane: (props: unknown) => require('react').createElement(
    require('react-native').View,
    { testID: 'overlay-chat', ...(props as object) },
  ),
}));

jest.mock('../../../lib/planner-folder-workspace', () => ({
  retryPlannerSessionWorkspace: jest.fn(),
}));

jest.mock('../../../lib/planner-folder-title-save', () => {
  const actual = jest.requireActual('../../../lib/planner-folder-title-save');
  return {
    ...actual,
    coordinateFolderWorkspaceClose: jest.fn(actual.coordinateFolderWorkspaceClose),
  };
});

jest.mock('../FolderSessionHistory', () => ({
  FolderSessionHistory: () => require('react').createElement(
    require('react-native').View,
    { testID: 'task-run-history' },
  ),
}));

beforeEach(() => {
  usePlannerStore.getState().resetForTest();
  useCardStore.setState({ rows: {}, details: {} });
  useSessionStore.setState({
    sessions: {
      'session-only': {
        agentSessionId: 'session-only',
        displayName: '독립 세션',
      } as Session,
    },
  });
  useUIStore.setState({
    selectedFolderPageId: null,
    selectedCardId: null,
    folderOverlayVisible: false,
    cardBoardExpanded: false,
    activeSessionId: null,
    focusEventId: null,
    initialCardSessionId: null,
    sessionFolderResolution: null,
  });
});

test('서버가 미소속으로 확인한 세션만 단독 채팅 안내를 렌더한다', () => {
  useUIStore.getState().openSessionOverlay('session-only');

  const screen = render(<FolderWorkspaceReadOverlay />);

  expect(screen.getByText('독립 세션')).toBeTruthy();
  expect(screen.getByText('이 세션은 폴더에 연결되어 있지 않아 세션 채팅만 표시합니다.')).toBeTruthy();
  expect(screen.queryByText(/캐시된 폴더 연결/)).toBeNull();
  expect(screen.getByTestId('overlay-chat')).toBeTruthy();
  expect(screen.getByTestId('overlay-chat').props.active).toBe(true);
  expect(screen.queryByTestId('task-run-history')).toBeNull();
});

test('닫힌 overlay는 ChatPane mount 상태를 보존하되 active=false로 상세 연결을 막는다', () => {
  useUIStore.setState({
    activeSessionId: 'session-only',
    folderOverlayVisible: false,
  });

  const screen = render(<FolderWorkspaceReadOverlay />);

  expect(screen.getByTestId('overlay-chat')).toBeTruthy();
  expect(screen.getByTestId('overlay-chat').props.active).toBe(false);
});

test('cache miss 조회 중에는 거짓 미소속 문구 대신 중립 loading을 렌더한다', () => {
  useUIStore.getState().openResolvingSessionOverlay('session-only');

  const screen = render(<FolderWorkspaceReadOverlay />);

  expect(screen.getByTestId('session-task-loading')).toBeTruthy();
  expect(screen.getByText('폴더 연결을 확인하는 중입니다.')).toBeTruthy();
  expect(screen.queryByText(/연결되어 있지 않아/)).toBeNull();
});

test('resolver 실패는 재시도 가능한 오류로 격리한다', () => {
  useUIStore.getState().openSessionResolutionError('session-only', 17, '조회 실패', true);

  const screen = render(<FolderWorkspaceReadOverlay />);
  fireEvent.press(screen.getByTestId('session-task-retry'));

  expect(screen.getByText('조회 실패')).toBeTruthy();
  expect(retryPlannerSessionWorkspace).toHaveBeenCalledWith('session-only', 17, null);
  expect(screen.queryByText(/연결되어 있지 않아/)).toBeNull();
});

test('계약 위반처럼 재시도로 해소되지 않는 오류는 거짓 재시도 버튼을 숨긴다', () => {
  useUIStore.getState().openSessionResolutionError(
    'session-only',
    17,
    '앱과 서버의 업무 조회 규격이 맞지 않습니다. 앱 업데이트가 필요합니다.',
    false,
  );

  const screen = render(<FolderWorkspaceReadOverlay />);

  expect(screen.getByText('앱과 서버의 업무 조회 규격이 맞지 않습니다. 앱 업데이트가 필요합니다.'))
    .toBeTruthy();
  expect(screen.queryByTestId('session-task-retry')).toBeNull();
});

test('업무 오버레이 배경 닫기도 동일 close coordinator를 거친다', async () => {
  useUIStore.getState().openFolderOverlay('task-1');
  const screen = render(<FolderWorkspaceReadOverlay />);

  await act(async () => { fireEvent.press(screen.getByTestId('task-workspace-backdrop-close')); });

  expect(coordinateFolderWorkspaceClose).toHaveBeenCalledWith('task-1', expect.any(Function));
  expect(useUIStore.getState().folderOverlayVisible).toBe(false);
});

test('업무 오버레이 루트가 하위 콘텐츠보다 높은 modal 계층을 소유한다', () => {
  useUIStore.getState().openFolderOverlay('task-1');

  const screen = render(<FolderWorkspaceReadOverlay />);
  const overlay = screen.getByTestId('task-workspace-overlay');
  const style = StyleSheet.flatten(overlay.props.style);

  expect(style.position).toBe('absolute');
  expect(style.zIndex).toBeGreaterThan(0);
  expect(overlay.props.pointerEvents).toBe('auto');
});

test('피드에서 선택한 소속 세션은 담당 세션보다 우선하고 상세 지연 뒤에도 유지한다', async () => {
  const detail = cardDetail('card-feed', 'owner');
  useSessionStore.setState({ sessions: {
    owner: { agentSessionId: 'owner', displayName: '담당 세션' } as Session,
    child: { agentSessionId: 'child', displayName: '선택한 소속 세션' } as Session,
  } });
  useUIStore.getState().openCardOverlay('card-feed', 'child');

  const screen = render(<FolderWorkspaceReadOverlay />);
  expect(useUIStore.getState().activeSessionId).toBe('child');

  await act(async () => {
    useCardStore.getState().putDetail({ ...detail, card: { ...detail.card, title: '늦게 도착한 상세' } });
  });
  expect(useUIStore.getState().activeSessionId).toBe('child');

  await act(async () => {
    useUIStore.getState().openCardOverlay('card-feed', 'child-2');
  });
  expect(screen.getByTestId('overlay-card-detail')).toBeTruthy();
  expect(useUIStore.getState().activeSessionId).toBe('child-2');
});

test('일반 카드 열기는 기존처럼 카드 담당 세션을 자동 선택한다', () => {
  useCardStore.getState().putDetail(cardDetail('card-owner', 'owner'));
  useUIStore.getState().openCardOverlay('card-owner');

  render(<FolderWorkspaceReadOverlay />);

  expect(useUIStore.getState()).toMatchObject({
    activeSessionId: 'owner',
    initialCardSessionId: null,
  });
});

test('업무 오버레이 시트는 glassSoft 24pt 네 모서리와 둥근 shadow frame을 공유한다', () => {
  useUIStore.getState().openFolderOverlay('task-1');

  const screen = render(<FolderWorkspaceReadOverlay />);
  const surfaceStyle = StyleSheet.flatten(
    screen.getByTestId('task-workspace-sheet-surface').props.style,
  );
  const frameStyle = StyleSheet.flatten(
    screen.getByTestId('task-workspace-sheet').props.style,
  );

  expect(surfaceStyle).toEqual(expect.objectContaining({
    borderRadius: 24,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderBottomLeftRadius: 24,
    borderBottomRightRadius: 24,
  }));
  expect(frameStyle).toEqual(expect.objectContaining({
    right: 0,
    top: 0,
    bottom: 0,
    borderRadius: 24,
  }));
});

test('업무 pane은 overlay 폭의 46%를 쓰되 좁고 넓은 iPad에서 clamp된다', () => {
  const metrics = TABLET_SHELL_LAYOUT.folderPane;

  expect(resolveFolderPaneWidth(700, metrics)).toBe(340);
  expect(resolveFolderPaneWidth(820, metrics)).toBe(377);
  expect(resolveFolderPaneWidth(920, metrics)).toBe(420);
});

test('the native board sheet and inline root exclusively host the same overlay', () => {
  useUIStore.getState().openSessionOverlay('session-only');
  const screen = render(<><FolderWorkspaceReadOverlay /><FolderWorkspaceReadOverlay host="board" /></>);
  expect(screen.getAllByTestId('task-workspace-overlay')).toHaveLength(1);
  act(() => { useUIStore.getState().setCardBoardExpanded(true); });
  expect(screen.getAllByTestId('task-workspace-overlay')).toHaveLength(1);
  expect(screen.getByTestId('overlay-chat').props.active).toBe(true);
  act(() => { useUIStore.getState().setCardBoardExpanded(false); });
  expect(screen.getAllByTestId('task-workspace-overlay')).toHaveLength(1);
});

function cardDetail(id: string, assigneeSessionId: string | null) {
  return { card: cardFixture({ id, assigneeSessionId, assigneeKind: assigneeSessionId ? 'session' : 'agent' }), sessions: [{ agentSessionId: 'worker', displayName: '소속 작업', status: 'idle', createdAt: '', updatedAt: '' }], questions: [], reports: [], comments: [] };
}

test('카드 첫 열기는 소속 작업이 아닌 담당 대화를 기존 오른쪽 패널에 선택한다', () => {
  useUIStore.setState({ activeSessionId: 'previous' });
  useCardStore.getState().putDetail(cardDetail('card-owner', 'owner'));
  useUIStore.getState().openCardOverlay('card-owner');
  const screen = render(<FolderWorkspaceReadOverlay />);
  expect(screen.getByTestId('overlay-card-detail')).toBeTruthy();
  expect(screen.getByTestId('overlay-chat').props.active).toBe(true);
  expect(useUIStore.getState().activeSessionId).toBe('owner');
});

test('카드 담당 없으면 기존 대화를 유지하고 이후 갱신은 자동 선택하지 않는다', async () => {
  useUIStore.setState({ activeSessionId: 'previous' });
  useUIStore.getState().openCardOverlay('card-empty');
  render(<FolderWorkspaceReadOverlay />);
  await act(async () => useCardStore.getState().putDetail(cardDetail('card-empty', null)));
  expect(useUIStore.getState().activeSessionId).toBe('previous');
  await act(async () => useCardStore.getState().putDetail(cardDetail('card-empty', 'late-owner')));
  expect(useUIStore.getState().activeSessionId).toBe('previous');
});

test('다른 카드 담당을 열되 수동 선택은 상세 갱신으로 덮지 않는다', async () => {
  useCardStore.getState().putDetail(cardDetail('first', 'first-owner'));
  useCardStore.getState().putDetail(cardDetail('second', 'second-owner'));
  useUIStore.getState().openCardOverlay('first');
  render(<FolderWorkspaceReadOverlay />);
  expect(useUIStore.getState().activeSessionId).toBe('first-owner');
  await act(async () => useUIStore.getState().openCardOverlay('second'));
  expect(useUIStore.getState().activeSessionId).toBe('second-owner');
  await act(async () => useUIStore.getState().setActiveSessionId('manual'));
  await act(async () => useCardStore.getState().putDetail(cardDetail('second', 'second-owner')));
  expect(useUIStore.getState().activeSessionId).toBe('manual');
  await act(async () => useUIStore.getState().closeFolderOverlay());
  await act(async () => useUIStore.getState().openCardOverlay('second'));
  expect(useUIStore.getState().activeSessionId).toBe('second-owner');
});

test('세션 담당이 아닌 카드의 소속 세션이나 불일치 ID를 자동 선택하지 않는다', () => {
  const detail = cardDetail('agent-only', 'worker');
  detail.card.assigneeKind = 'agent';
  useCardStore.getState().putDetail(detail);
  useUIStore.setState({ activeSessionId: 'previous' });
  useUIStore.getState().openCardOverlay(detail.card.id);
  render(<FolderWorkspaceReadOverlay />);
  expect(useUIStore.getState().activeSessionId).toBe('previous');
});
