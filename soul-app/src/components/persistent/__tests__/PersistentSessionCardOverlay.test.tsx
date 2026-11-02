jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
let mockDeviceType = 'tabletLandscape';
let mockWindowDimensions = { width: 1024, height: 1366, scale: 1, fontScale: 1 };
jest.mock('../../../theme/useDeviceType', () => ({
  useDeviceType: () => mockDeviceType,
  deviceTypeToBaseKey: (device: string) => device === 'phone' ? 'phone' : 'tablet',
}));
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: () => mockWindowDimensions,
}));
jest.mock('../../planner/CardDetailSheet', () => ({
  CardDetailContent: (props: any) => require('react').createElement(
    require('react-native').Pressable,
    { testID: 'overlay-card-detail', onPress: () => props.onOpenSession?.('selected-session') },
  ),
}));
jest.mock('../../split/ChatPane', () => ({
  ChatPane: (props: any) => require('react').createElement(
    require('react-native').View,
    { testID: 'overlay-chat-pane', ...props },
  ),
}));
jest.mock('../../planner/FolderWorkspaceReadOverlay', () => ({
  CardPanelOverlayFrame: ({ children, chatPaneMinimumBottomPadding, sheetTop, sheetRight, width, direction }: any) => require('react').createElement(
    require('react-native').View,
    { testID: 'overlay-frame', chatPaneMinimumBottomPadding, sheetTop, sheetRight, width, direction },
    children,
  ),
  DuoTopBandRailScope: ({ children }: any) => children,
  FolderWorkspaceSinglePanel: (props: any) => require('react').createElement(
    require('react-native').View,
    { testID: 'folder-workspace-single-panel', ownsSessionConnection: props.ownsSessionConnection,
      cardId: props.cardId, sessionId: props.sessionId, active: props.active },
  ),
  CardDetailChatPanes: ({ hideChat, sessionId, active, onCloseChat, ownsSessionConnection }: any) => require('react').createElement(
    require('react-native').View,
    null,
    require('react').createElement(require('react-native').View, { testID: 'task-workspace-task-pane' }),
    require('react').createElement(require('react-native').View, { testID: 'task-workspace-chat-pane' },
      hideChat ? null : require('react').createElement(require('../../split/ChatPane').ChatPane,
        { sessionId, active, onClose: onCloseChat, ownsSessionConnection })),
  ),
}));

import React from 'react';
import { render } from '@testing-library/react-native';
import { useCardStore } from '../../../store/cardStore';
import { useUIStore } from '../../../store/uiStore';
import { PersistentSessionCardOverlay } from '../PersistentSessionCardOverlay';

const api = {} as any;

beforeEach(() => {
  mockDeviceType = 'tabletLandscape';
  mockWindowDimensions = { width: 1024, height: 1366, scale: 1, fontScale: 1 };
  useCardStore.setState({ details: { 'card-1': { card: {
    id: 'card-1', assigneeKind: 'session', assigneeSessionId: 'assigned-1',
  } } as any } });
  useUIStore.setState({ activeSessionId: 'pas-1' });
});

test('iPad 상세 패널은 담당 세션과 하단 안전 영역을 프레임에 전달한다', () => {
  const screen = render(<PersistentSessionCardOverlay api={api} cardId="card-1" sessionId="pas-1" bottomSafeAreaInset={20} onClose={jest.fn()} />);

  expect(screen.getByTestId('task-workspace-task-pane')).toBeTruthy();
  expect(screen.getByTestId('overlay-chat-pane').props.sessionId).toBe('assigned-1');
  expect(screen.getByTestId('overlay-chat-pane').props.active).toBe(true);
  expect(screen.getByTestId('overlay-chat-pane').props.ownsSessionConnection).toBe(true);
  expect(screen.getByTestId('overlay-frame').props.chatPaneMinimumBottomPadding).toBe(20);
  expect(useUIStore.getState().activeSessionId).toBe('pas-1');
});

test('상단 띠가 있는 화면의 시트 오프셋을 카드 프레임에 전달한다', () => {
  const screen = render(<PersistentSessionCardOverlay api={api} cardId="card-1" sessionId="pas-1" bottomSafeAreaInset={0} sheetTop={82} onClose={jest.fn()} />);
  expect(screen.getByTestId('overlay-frame').props.sheetTop).toBe(82);
});

test('안쪽 세로 레일 밴드는 카드 시트를 한 칸으로 열고 오른쪽 열을 비운다', () => {
  mockDeviceType = 'tabletPortrait';
  mockWindowDimensions = { width: 669, height: 951, scale: 1, fontScale: 1 };
  const screen = render(<PersistentSessionCardOverlay api={api} cardId="card-1" sessionId="pas-1"
    bottomSafeAreaInset={0} railBand onClose={jest.fn()} />);

  expect(screen.queryByTestId('task-workspace-chat-pane')).toBeNull();
  expect(screen.getByTestId('folder-workspace-single-panel')).toBeTruthy();
  expect(screen.getByTestId('folder-workspace-single-panel').props.ownsSessionConnection).toBe(true);
  expect(screen.getByTestId('overlay-frame').props).toMatchObject({
    width: 585,
    sheetRight: 84,
    direction: 'column',
  });
});

test('담당이 PAS 자신이어도 대화 pane을 렌더하고 배경 ChatBody가 연결을 소유한다', () => {
  useCardStore.setState({ details: { 'card-1': { card: {
    id: 'card-1', assigneeKind: 'session', assigneeSessionId: 'pas-1',
  } } as any } });
  const screen = render(<PersistentSessionCardOverlay api={api} cardId="card-1" sessionId="pas-1" bottomSafeAreaInset={20} onClose={jest.fn()} />);

  expect(screen.getByTestId('task-workspace-task-pane')).toBeTruthy();
  expect(screen.getByTestId('task-workspace-chat-pane').children).toHaveLength(1);
  expect(screen.getByTestId('overlay-chat-pane').props.sessionId).toBe('pas-1');
  expect(screen.getByTestId('overlay-chat-pane').props.active).toBe(true);
  expect(screen.getByTestId('overlay-chat-pane').props.ownsSessionConnection).toBe(false);
});

test('iPhone에서는 태블릿 카드 패널 오버레이를 렌더하지 않는다', () => {
  mockDeviceType = 'phone';
  const screen = render(<PersistentSessionCardOverlay api={api} cardId="card-1" sessionId="pas-1" bottomSafeAreaInset={20} onClose={jest.fn()} />);

  expect(screen.queryByTestId('overlay-frame')).toBeNull();
  expect(screen.queryByTestId('overlay-chat-pane')).toBeNull();
});

test('담당 세션이 없는 카드는 기존 대화 빈 상태를 사용한다', () => {
  useCardStore.setState({ details: { 'card-1': { card: {
    id: 'card-1', assigneeKind: 'agent', assigneeSessionId: null,
  } } as any } });
  const screen = render(<PersistentSessionCardOverlay api={api} cardId="card-1" sessionId="pas-1" bottomSafeAreaInset={20} onClose={jest.fn()} />);

  expect(screen.getByTestId('overlay-chat-pane').props.sessionId).toBeNull();
});
