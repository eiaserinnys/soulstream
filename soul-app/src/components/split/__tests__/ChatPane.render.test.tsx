jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
let mockSafeAreaInsets = { top: 24, bottom: 20, left: 0, right: 0 };
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => mockSafeAreaInsets,
}));
jest.mock('../../chat/ChatBody', () => ({
  ChatBody: (props: unknown) => require('react').createElement(
    require('react-native').View,
    { testID: 'chat-body', ...(props as object) },
  ),
}));

let mockDimensions = { width: 1024, height: 1366, scale: 2, fontScale: 1 };
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: () => mockDimensions,
}));

import React from 'react';
import { StyleSheet } from 'react-native';
import { fireEvent, render } from '@testing-library/react-native';
import type { Session } from '../../../api/types';
import { useSessionStore } from '../../../store/sessionStore';
import { useUIStore } from '../../../store/uiStore';
import { TABLET_SHELL_LAYOUT } from '../../../theme';
import { ChatPane } from '../ChatPane';

test.each([
  [1, 0],
  [2, 34],
])('iPad fontScale %s·bottom inset %s 채팅 chrome은 화면 좌표 회피와 내부 홈 인디케이터 보호를 쓴다', (
  fontScale,
  bottomInset,
) => {
  mockDimensions = { ...mockDimensions, fontScale };
  mockSafeAreaInsets = { ...mockSafeAreaInsets, bottom: bottomInset };
  useSessionStore.setState({
    sessions: {
      session: {
        agentSessionId: 'session',
        displayName: '채팅 제목',
        status: 'running',
        createdAt: '',
        updatedAt: '',
      } as Session,
    },
  });
  useUIStore.setState({ activeSessionId: 'session', focusEventId: null });

  const screen = render(<ChatPane active={false} />);
  const style = StyleSheet.flatten(screen.getByTestId('tablet-chat-header').props.style);

  expect(screen.getByText('채팅 제목')).toBeTruthy();
  expect(style.borderWidth).toBe(0);
  expect(style.borderRadius).toBe(0);
  expect(style.backgroundColor).toBeTruthy();
  expect(style.height).toBeUndefined();
  expect(style.minHeight).toBe(TABLET_SHELL_LAYOUT.header.minHeight);
  expect(style.paddingHorizontal).toBe(20);
  expect(style.paddingVertical).toBe(6);
  expect(screen.getByTestId('chat-body').props.keyboardOffset).toBeUndefined();
  expect(screen.getByTestId('chat-body').props.minimumBottomPadding).toBe(
    Math.max(0, bottomInset - TABLET_SHELL_LAYOUT.outerInset),
  );
  expect(screen.getByTestId('chat-body').props.active).toBe(false);

  const title = screen.getByText('채팅 제목');
  expect(title.props.numberOfLines).toBe(1);
  expect(title.props.ellipsizeMode).toBe('tail');
  expect(title.props.allowFontScaling).not.toBe(false);
  expect(StyleSheet.flatten(title.props.style)).toEqual(expect.objectContaining({
    fontSize: 20,
    lineHeight: 26,
    fontWeight: '600',
  }));

  const closeStyle = StyleSheet.flatten(screen.getByTestId('tablet-chat-close').props.style);
  expect(closeStyle.minWidth).toBeGreaterThanOrEqual(48);
  expect(closeStyle.minHeight).toBeGreaterThanOrEqual(48);
});

test('명시한 세션만 표시하고 닫기는 PAS의 전역 세션을 바꾸지 않는다', () => {
  const close = jest.fn();
  useSessionStore.setState({ sessions: {
    'pas-1': { agentSessionId: 'pas-1', displayName: 'PAS', status: 'running', createdAt: '', updatedAt: '' } as Session,
    'assigned-1': { agentSessionId: 'assigned-1', displayName: '담당 세션', status: 'idle', createdAt: '', updatedAt: '' } as Session,
  } });
  useUIStore.setState({ activeSessionId: 'pas-1', focusEventId: 17, storyOpenRequestId: 23 });

  const screen = render(<ChatPane sessionId="assigned-1" active onClose={close} />);

  expect(screen.getByText('담당 세션')).toBeTruthy();
  expect(screen.getByTestId('chat-body').props.sessionId).toBe('assigned-1');
  expect(screen.getByTestId('chat-body').props.focusEventId).toBeUndefined();
  expect(screen.getByTestId('chat-body').props.storyOpenRequestId).toBeUndefined();
  expect(screen.getByTestId('chat-body').props.onFocusEventHandled).toBeUndefined();
  expect(screen.getByTestId('chat-body').props.onStoryOpenRequestHandled).toBeUndefined();
  fireEvent.press(screen.getByTestId('tablet-chat-close'));
  expect(close).toHaveBeenCalledTimes(1);
  expect(useUIStore.getState().activeSessionId).toBe('pas-1');
});

test('명시한 빈 세션은 전역 선택 세션 대신 기존 빈 대화 상태를 보인다', () => {
  useUIStore.setState({ activeSessionId: 'pas-1', focusEventId: null });
  const screen = render(<ChatPane sessionId={null} active={false} />);

  expect(screen.getByText('채팅')).toBeTruthy();
  expect(screen.getByTestId('chat-body').props.sessionId).toBeUndefined();
  expect(useUIStore.getState().activeSessionId).toBe('pas-1');
});
