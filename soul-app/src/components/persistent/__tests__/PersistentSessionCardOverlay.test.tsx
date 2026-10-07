jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
let mockDeviceType = 'tabletLandscape';
jest.mock('../../../theme/useDeviceType', () => ({
  useDeviceType: () => mockDeviceType,
  deviceTypeToBaseKey: (device: string) => device === 'phone' ? 'phone' : 'tablet',
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
  CardPanelOverlayFrame: ({ children }: any) => require('react').createElement(
    require('react-native').View,
    { testID: 'overlay-frame' },
    children,
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
  useCardStore.setState({ details: { 'card-1': { card: {
    id: 'card-1', assigneeKind: 'session', assigneeSessionId: 'assigned-1',
  } } as any } });
  useUIStore.setState({ activeSessionId: 'pas-1' });
});

test('iPad 상세 패널은 담당 세션을 독립된 대화 pane에 전달한다', () => {
  const screen = render(<PersistentSessionCardOverlay api={api} cardId="card-1" sessionId="pas-1" onClose={jest.fn()} />);

  expect(screen.getByTestId('task-workspace-task-pane')).toBeTruthy();
  expect(screen.getByTestId('overlay-chat-pane').props.sessionId).toBe('assigned-1');
  expect(screen.getByTestId('overlay-chat-pane').props.active).toBe(true);
  expect(screen.getByTestId('overlay-chat-pane').props.ownsSessionConnection).toBe(true);
  expect(useUIStore.getState().activeSessionId).toBe('pas-1');
});

test('담당이 PAS 자신이어도 대화 pane을 렌더하고 배경 ChatBody가 연결을 소유한다', () => {
  useCardStore.setState({ details: { 'card-1': { card: {
    id: 'card-1', assigneeKind: 'session', assigneeSessionId: 'pas-1',
  } } as any } });
  const screen = render(<PersistentSessionCardOverlay api={api} cardId="card-1" sessionId="pas-1" onClose={jest.fn()} />);

  expect(screen.getByTestId('task-workspace-task-pane')).toBeTruthy();
  expect(screen.getByTestId('task-workspace-chat-pane').children).toHaveLength(1);
  expect(screen.getByTestId('overlay-chat-pane').props.sessionId).toBe('pas-1');
  expect(screen.getByTestId('overlay-chat-pane').props.active).toBe(true);
  expect(screen.getByTestId('overlay-chat-pane').props.ownsSessionConnection).toBe(false);
});

test('iPhone에서는 태블릿 카드 패널 오버레이를 렌더하지 않는다', () => {
  mockDeviceType = 'phone';
  const screen = render(<PersistentSessionCardOverlay api={api} cardId="card-1" sessionId="pas-1" onClose={jest.fn()} />);

  expect(screen.queryByTestId('overlay-frame')).toBeNull();
  expect(screen.queryByTestId('overlay-chat-pane')).toBeNull();
});

test('담당 세션이 없는 카드는 기존 대화 빈 상태를 사용한다', () => {
  useCardStore.setState({ details: { 'card-1': { card: {
    id: 'card-1', assigneeKind: 'agent', assigneeSessionId: null,
  } } as any } });
  const screen = render(<PersistentSessionCardOverlay api={api} cardId="card-1" sessionId="pas-1" onClose={jest.fn()} />);

  expect(screen.getByTestId('overlay-chat-pane').props.sessionId).toBeNull();
});
