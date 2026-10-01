import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import type { Session } from '../../../api/types';
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
    folderOverlayVisible: false,
    activeSessionId: null,
    focusEventId: null,
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

test('업무 오버레이 배경 닫기도 동일 close coordinator를 거친다', () => {
  useUIStore.getState().openFolderOverlay('task-1');
  const screen = render(<FolderWorkspaceReadOverlay />);

  fireEvent.press(screen.getByTestId('task-workspace-backdrop-close'));

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
