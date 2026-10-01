import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { useSessionStore } from '../../../store/sessionStore';
import { useNodeConnectivityStore } from '../../../store/nodeConnectivityStore';
import { FolderSessionHistory } from '../FolderSessionHistory';
jest.mock('../../../hooks/usePlannerReads', () => ({ usePlannerFolderSessions: () => ({ data: null, loading: false, error: null }) }));
jest.mock('../../useSessionCardAnimation', () => ({ useSessionCardAnimation: () => {
  const { Animated } = require('react-native');
  return { pulse: new Animated.Value(0), shimmer: new Animated.Value(0), reducedMotion: true, appActive: true, animationEnabled: false };
} }));
beforeEach(() => {
  useNodeConnectivityStore.getState().reset();
  const root = { agentSessionId: 'root', displayName: '담당 세션', status: 'idle', agentName: '로젤린', createdAt: '', updatedAt: '' };
  useSessionStore.setState({ sessions: { root, child: { ...root, agentSessionId: 'child', displayName: '작업 세션', callerSessionId: 'root' } } });
});
test('폴더 기본 세션 목록 렌더는 보완 전과 같다', () => {
  const screen = render(<FolderSessionHistory api={null} sessionIds={['root', 'child']} />);
  expect(screen.toJSON()).toMatchSnapshot();
});
test('small은 기본 초상·패딩·들여쓰기를 유지하고 두 줄만 렌더한다', () => {
  const open = jest.fn();
  const screen = render(<FolderSessionHistory api={null} sessionIds={['root', 'child']} small onOpenSession={open} />);
  expect(StyleSheet.flatten(screen.getByTestId('task-run-row-root').props.style)).toMatchObject({ paddingVertical: 16, paddingHorizontal: 16 });
  expect(StyleSheet.flatten(screen.getByTestId('task-run-row-root').props.style).minHeight).toBeUndefined();
  expect(screen.queryByTestId('session-card-context-row')).toBeNull();
  expect(StyleSheet.flatten(screen.getByTestId('task-run-avatar-root').props.style)).toMatchObject({ width: 44, height: 44 });
  expect(StyleSheet.flatten(screen.getByTestId('task-run-depth-child').props.style).marginLeft).toBe(16);
  fireEvent.press(screen.getByTestId('task-run-row-child'));
  expect(open).toHaveBeenCalledWith('child');
});
