const mockOpenSessionMenu = jest.fn();
const mockChatBody = jest.fn((_props: unknown) => null);
let mockIsFocused = true;

jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
jest.mock('@react-navigation/elements', () => ({ useHeaderHeight: () => 44 }));
jest.mock('@react-navigation/native', () => ({
  useFocusEffect: jest.fn(),
  useIsFocused: () => mockIsFocused,
}));
jest.mock('../../navigation/TabNavigator', () => ({
  getDefaultTabBarStyle: () => ({ display: 'flex' }),
}));
jest.mock('../../hooks/usePlannerContextMenus', () => ({
  usePlannerContextMenus: () => ({
    openSessionMenu: mockOpenSessionMenu,
    sessionSuccession: null,
    closeSessionSuccession: jest.fn(),
  }),
}));
jest.mock('../../components/chat/ChatBody', () => ({
  ChatBody: (props: unknown) => mockChatBody(props),
}));
jest.mock('../../components/chat/StatusDot', () => {
  const ReactModule = require('react');
  const { View } = require('react-native');
  return {
    StatusDot: () => ReactModule.createElement(View, { testID: 'mock-chat-status-dot' }),
  };
});
jest.mock('../../components/planner/SessionSuccessionHost', () => ({ SessionSuccessionHost: () => null }));

import React from 'react';
import { Keyboard, Platform, StyleSheet } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { fireEvent, render } from '@testing-library/react-native';
import type { Session } from '../../api/types';
import type { PhonePanelHistory } from '../../navigation/phonePanelHistory';
import {
  PhonePanelHistoryProvider,
  usePhonePanelHistory,
} from '../../navigation/phonePanelHistory';
import { useSessionStore } from '../../store/sessionStore';
import { ChatScreen } from '../ChatScreen';

let capturedHistory: PhonePanelHistory | null = null;

beforeEach(() => {
  mockIsFocused = true;
  mockChatBody.mockClear();
});

function CaptureHistory() {
  capturedHistory = usePhonePanelHistory();
  return null;
}

test('session이 있는 phone Chat header menu는 44×44 touch target과 기존 동작을 보존한다', () => {
  useSessionStore.setState({
    sessions: {
      'session-1': {
        agentSessionId: 'session-1',
        displayName: '검수할 채팅',
        status: 'running',
        createdAt: '',
        updatedAt: '',
      } as Session,
    },
  });
  const navigation = {
    getParent: jest.fn(),
    navigate: jest.fn(),
    setOptions: jest.fn(),
    setParams: jest.fn(),
  };

  render(
    <PhonePanelHistoryProvider>
      <CaptureHistory />
      <ChatScreen
        route={{ key: 'chat', name: 'Chat', params: { sessionId: 'session-1' } } as any}
        navigation={navigation as any}
      />
    </PhonePanelHistoryProvider>,
  );

  const options = navigation.setOptions.mock.calls.at(-1)?.[0];
  expect(options).toEqual(expect.objectContaining({ title: '검수할 채팅', headerTitle: undefined }));
  expect(options.headerLeft).toEqual(expect.any(Function));
  expect(options.headerRight).toEqual(expect.any(Function));

  const header = render(React.createElement(options.headerRight));
  const menu = header.getByLabelText('세션 메뉴');
  const style = StyleSheet.flatten(menu.props.style);
  expect(style.minWidth).toBeGreaterThanOrEqual(44);
  expect(style.minHeight).toBeGreaterThanOrEqual(44);
  expect(style.alignItems).toBe('center');
  expect(style.justifyContent).toBe('center');

  fireEvent.press(menu);
  expect(mockOpenSessionMenu).toHaveBeenCalledWith({ sessionId: 'session-1' });
});

test('header 선렌더 뒤 focus history가 바뀌어도 press 순간 최신 FolderTab으로 돌아간다', () => {
  useSessionStore.setState({
    sessions: {
      'session-1': {
        agentSessionId: 'session-1',
        displayName: '검수할 채팅',
        status: 'running',
        createdAt: '',
        updatedAt: '',
      } as Session,
    },
  });
  const navigate = jest.fn();
  const navigation = {
    getParent: jest.fn(() => ({ navigate })),
    navigate: jest.fn(),
    setOptions: jest.fn(),
    setParams: jest.fn(),
  };

  render(
    <PhonePanelHistoryProvider>
      <CaptureHistory />
      <ChatScreen
        route={{ key: 'chat', name: 'Chat', params: { sessionId: 'session-1' } } as any}
        navigation={navigation as any}
      />
    </PhonePanelHistoryProvider>,
  );
  const options = navigation.setOptions.mock.calls.at(-1)?.[0];
  const headerLeft = render(React.createElement(options.headerLeft));
  expect(headerLeft.getByTestId('mock-chat-status-dot')).toBeTruthy();

  capturedHistory!.recordFocus('FolderTab');
  capturedHistory!.recordChatOpen();
  const back = headerLeft.getByLabelText('이전 패널로 돌아가기');
  const style = StyleSheet.flatten(back.props.style);
  expect(back.props.accessibilityHint).toBe('채팅을 열기 전에 보던 화면으로 돌아갑니다');
  expect(style.width).toBeGreaterThanOrEqual(44);
  expect(style.height).toBeGreaterThanOrEqual(44);
  expect(headerLeft.UNSAFE_getAllByType('Ionicons' as any)[0].props.name).toBe('arrow-back');

  fireEvent.press(back);

  expect(navigate).toHaveBeenCalledWith('FolderTab');
});

test.each([
  [true, true],
  [false, false],
])('phone focus=%s를 ChatBody active=%s로 전달한다', (focused, expectedActive) => {
  mockIsFocused = focused;
  useSessionStore.setState({
    sessions: {
      'session-1': {
        agentSessionId: 'session-1',
        displayName: '포커스 채팅',
        status: 'running',
        createdAt: '2026-09-07T00:00:00Z',
        updatedAt: '2026-09-07T00:00:00Z',
      },
    },
  });
  const navigation = {
    getParent: jest.fn(),
    navigate: jest.fn(),
    setOptions: jest.fn(),
    setParams: jest.fn(),
  };

  render(
    <PhonePanelHistoryProvider>
      <ChatScreen
        route={{ key: 'chat', name: 'Chat', params: { sessionId: 'session-1' } } as any}
        navigation={navigation as any}
      />
    </PhonePanelHistoryProvider>,
  );

  expect(mockChatBody).toHaveBeenLastCalledWith(
    expect.objectContaining({ sessionId: 'session-1', active: expectedActive }),
  );
});

test('Chat focus hides the parent tab bar for keyboard events and restores it on hide and blur', () => {
  const listeners = new Map<string, (event: unknown) => void>();
  const removeListener = jest.fn();
  const addListener = jest.spyOn(Keyboard, 'addListener').mockImplementation(((
    eventName: string,
    listener: (...args: any[]) => void,
  ) => {
    listeners.set(eventName, listener as (event: unknown) => void);
    return { remove: removeListener } as any;
  }) as any);
  let focusEffect: (() => void | (() => void)) | undefined;
  (useFocusEffect as jest.Mock).mockImplementation((effect: () => void | (() => void)) => {
    focusEffect = effect;
  });
  const setTabOptions = jest.fn();
  const navigation = {
    getParent: () => ({ setOptions: setTabOptions }),
    getState: () => ({ index: 0, routes: [{ key: 'chat-keyboard' }] }),
    navigate: jest.fn(),
    setOptions: jest.fn(),
    setParams: jest.fn(),
  };

  render(
    <PhonePanelHistoryProvider>
      <ChatScreen
        route={{ key: 'chat-keyboard', name: 'Chat', params: { sessionId: 'session-1' } } as any}
        navigation={navigation as any}
      />
    </PhonePanelHistoryProvider>,
  );
  const cleanup = focusEffect!();
  setTabOptions.mockClear();

  const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
  const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
  expect(listeners.has(showEvent)).toBe(true);
  expect(listeners.has(hideEvent)).toBe(true);
  listeners.get(showEvent)!({});
  expect(setTabOptions).toHaveBeenLastCalledWith({ tabBarStyle: { display: 'none' } });
  listeners.get(hideEvent)!({});
  expect(setTabOptions).toHaveBeenLastCalledWith({ tabBarStyle: { display: 'flex' } });

  if (typeof cleanup === 'function') cleanup();
  expect(setTabOptions).toHaveBeenLastCalledWith({ tabBarStyle: { display: 'flex' } });
  expect(removeListener).toHaveBeenCalledTimes(2);
  addListener.mockRestore();
  (useFocusEffect as jest.Mock).mockReset();
});
