import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import { Alert, StyleSheet } from 'react-native';
import type { PlannerFolder } from '../../api/plannerTypes';
import { useSettingsStore } from '../../store/settingsStore';

const mockGestures: any[] = [];
const mockUsePlannerStarred = jest.fn();
const mockOpenFolderMenu = jest.fn();

jest.mock('react-native-gesture-handler', () => {
  const ReactModule = require('react');
  const { View } = require('react-native');
  const createPan = () => {
    const gesture: any = {
      callbacks: {},
      enabledValue: true,
      longPressDelay: 0,
      enabled(value: boolean) {
        this.enabledValue = value;
        return this;
      },
      activateAfterLongPress(value: number) {
        this.longPressDelay = value;
        return this;
      },
      onStart(callback: (...args: any[]) => void) {
        this.callbacks.start = callback;
        return this;
      },
      onUpdate(callback: (...args: any[]) => void) {
        this.callbacks.update = callback;
        return this;
      },
      onEnd(callback: (...args: any[]) => void) {
        this.callbacks.end = callback;
        return this;
      },
      onFinalize(callback: (...args: any[]) => void) {
        this.callbacks.finalize = callback;
        return this;
      },
    };
    mockGestures.push(gesture);
    return gesture;
  };
  return {
    Gesture: { Pan: createPan },
    GestureDetector: ({ gesture, children }: { gesture: any; children: React.ReactNode }) => {
      const pageId = (children as any)?.props?.children?.props?.folder?.page?.id;
      gesture.pageId = pageId;
      return ReactModule.createElement(View, { testID: `starred-gesture-${pageId}` }, children);
    },
  };
});

jest.mock('../../api/client', () => ({ createApiClient: jest.fn(() => ({})) }));
jest.mock('../../hooks/usePlannerReads', () => ({
  usePlannerStarred: (...args: unknown[]) => mockUsePlannerStarred(...args),
}));
jest.mock('../../hooks/usePlannerContextMenus', () => ({
  usePlannerContextMenus: () => ({ openFolderMenu: (...args: unknown[]) => mockOpenFolderMenu(...args) }),
}));

import { StarredFoldersScreen } from '../StarredFoldersScreen';

const folderA = plannerFolder('a');
const folderB = plannerFolder('b');
const folderC = plannerFolder('c');
const folderD = plannerFolder('d');

function plannerFolder(id: string): PlannerFolder {
  return {
    page: {
      id, title: `업무 ${id}`, dailyDate: null, version: 1, archived: false,
      metadata: { starred: true }, createdAt: '', updatedAt: '',
    },
    blocks: [], folderId: `task-${id}`, folderSummary: null, status: 'open', assignee: '',
    contextCount: 0, progress: null, projectPageId: null, sessions: [],
    sessionIds: [],
  };
}

function latestGesture(pageId: string) {
  return mockGestures.filter((gesture) => gesture.pageId === pageId).slice(-1)[0];
}

function rowY(index: number): number {
  return index * (80 + StyleSheet.hairlineWidth);
}

beforeEach(() => {
  mockGestures.length = 0;
  mockUsePlannerStarred.mockReset();
  mockOpenFolderMenu.mockReset();
  useSettingsStore.setState({ serverUrl: '' });
});

afterEach(() => {
  jest.restoreAllMocks();
});

test('측정된 행만 드래그하고 빠른 탭은 업무를 열며 드래그 중 스크롤과 더 보기를 막는다', () => {
  const state = {
    data: { items: [folderA, folderB], nextCursor: 'cursor-2' },
    loading: false,
    error: null,
    refresh: jest.fn(),
    loadMore: jest.fn(),
    moveFolderOrder: jest.fn().mockResolvedValue(undefined),
    reordering: false,
  };
  mockUsePlannerStarred.mockReturnValue(state);
  const onOpenFolder = jest.fn();
  const screen = render(<StarredFoldersScreen onOpenFolder={onOpenFolder} />);
  const scroll = screen.getByTestId('starred-task-scroll');
  const more = screen.getByTestId('starred-load-more');

  expect(scroll.props.scrollEnabled).toBe(true);
  expect(latestGesture('a').enabledValue).toBe(false);
  expect(latestGesture('a').longPressDelay).toBe(350);

  fireEvent.press(screen.getByTestId('planner-task-row-a'));
  expect(onOpenFolder).toHaveBeenCalledWith(folderA);

  fireEvent(screen.getByTestId('starred-draggable-task-row-a'), 'layout', {
    nativeEvent: { layout: { x: 0, y: 0, width: 320, height: 80 } },
  });
  fireEvent(screen.getByTestId('starred-draggable-task-row-b'), 'layout', {
    nativeEvent: { layout: { x: 0, y: rowY(1), width: 320, height: 80 } },
  });
  expect(latestGesture('a').enabledValue).toBe(true);

  const contextMenuGesture = latestGesture('b');
  act(() => { contextMenuGesture.callbacks.start({ y: 40 }); });
  act(() => { contextMenuGesture.callbacks.end({ y: 40, translationY: 0 }); });
  act(() => { contextMenuGesture.callbacks.finalize({}, true); });
  expect(mockOpenFolderMenu).toHaveBeenCalledWith(folderB, expect.any(Function));
  expect(state.moveFolderOrder).not.toHaveBeenCalled();
  expect(onOpenFolder).toHaveBeenCalledTimes(1);

  const gesture = latestGesture('a');
  act(() => { gesture.callbacks.start({ y: 40 }); });
  expect(scroll.props.scrollEnabled).toBe(false);
  expect(more.props.accessibilityState.disabled).toBe(true);

  act(() => { gesture.callbacks.update({ translationY: 90 }); });
  act(() => { gesture.callbacks.end({ y: 40, translationY: 90 }); });
  act(() => { gesture.callbacks.finalize({}, true); });
  expect(state.moveFolderOrder).toHaveBeenCalledWith('a', null);
  expect(scroll.props.scrollEnabled).toBe(true);

  fireEvent.press(more);
  expect(state.loadMore).toHaveBeenCalledTimes(1);

  state.reordering = true;
  screen.rerender(<StarredFoldersScreen onOpenFolder={onOpenFolder} />);
  expect(screen.getByTestId('starred-task-scroll').props.scrollEnabled).toBe(false);
  expect(screen.getByTestId('starred-load-more').props.accessibilityState.disabled).toBe(true);
  expect(latestGesture('a').enabledValue).toBe(false);
});

test('순서 저장 실패는 화면의 기존 Alert 안내를 사용한다', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  const state = {
    data: { items: [folderA], nextCursor: null },
    loading: false,
    error: null,
    refresh: jest.fn(),
    loadMore: jest.fn(),
    moveFolderOrder: jest.fn().mockRejectedValue(new Error('저장 실패')),
    reordering: false,
  };
  mockUsePlannerStarred.mockReturnValue(state);
  const screen = render(<StarredFoldersScreen />);
  fireEvent(screen.getByTestId('starred-draggable-task-row-a'), 'layout', {
    nativeEvent: { layout: { x: 0, y: 0, width: 320, height: 80 } },
  });

  const gesture = latestGesture('a');
  await act(async () => {
    gesture.callbacks.start({ y: 40 });
    gesture.callbacks.update({ translationY: 24 });
    gesture.callbacks.end({ y: 40, translationY: 24 });
    gesture.callbacks.finalize({}, true);
    await Promise.resolve();
  });

  expect(state.moveFolderOrder).toHaveBeenCalledWith('a', null);
  expect(alert).toHaveBeenCalledWith('작업을 완료하지 못했습니다.', '저장 실패');
  alert.mockRestore();
});

test('cursor가 무효화된 목록은 더 보기 대신 첫 페이지 새로고침을 제공한다', () => {
  const refresh = jest.fn();
  const state = {
    data: { items: [folderA], nextCursor: null },
    loading: false,
    error: '첫 페이지 조회 실패',
    refresh,
    refreshRequired: true,
    loadMore: jest.fn(),
    moveFolderOrder: jest.fn().mockResolvedValue(undefined),
    reordering: false,
  };
  mockUsePlannerStarred.mockReturnValue(state);
  const screen = render(<StarredFoldersScreen />);

  expect(screen.getByText('목록 새로고침')).toBeTruthy();
  expect(screen.getByText('첫 페이지 조회 실패')).toBeTruthy();
  fireEvent(screen.getByTestId('starred-draggable-task-row-a'), 'layout', {
    nativeEvent: { layout: { x: 0, y: 0, width: 320, height: 80 } },
  });
  expect(latestGesture('a').enabledValue).toBe(false);
  fireEvent.press(screen.getByTestId('starred-load-more'));
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(state.loadMore).not.toHaveBeenCalled();
});

test('swap 뒤 바뀐 행만 재측정되면 고정 행 geometry를 유지해 다음 drag를 허용한다', async () => {
  const state = {
    data: { items: [folderA, folderB, folderC], nextCursor: null },
    loading: false,
    error: null,
    refresh: jest.fn(),
    loadMore: jest.fn(),
    moveFolderOrder: jest.fn().mockResolvedValue(undefined),
    reordering: false,
  };
  mockUsePlannerStarred.mockReturnValue(state);
  const screen = render(<StarredFoldersScreen />);
  for (const [id, y] of [['a', rowY(0)], ['b', rowY(1)], ['c', rowY(2)]] as const) {
    fireEvent(screen.getByTestId(`starred-draggable-task-row-${id}`), 'layout', {
      nativeEvent: { layout: { x: 0, y, width: 320, height: 80 } },
    });
  }

  state.data = { items: [folderB, folderA, folderC], nextCursor: null };
  screen.rerender(<StarredFoldersScreen />);
  expect(latestGesture('b').enabledValue).toBe(false);
  fireEvent(screen.getByTestId('starred-draggable-task-row-b'), 'layout', {
    nativeEvent: { layout: { x: 0, y: rowY(0), width: 320, height: 80 } },
  });
  fireEvent(screen.getByTestId('starred-draggable-task-row-a'), 'layout', {
    nativeEvent: { layout: { x: 0, y: rowY(1), width: 320, height: 80 } },
  });

  expect(latestGesture('c').enabledValue).toBe(true);
  const gesture = latestGesture('b');
  await act(async () => {
    gesture.callbacks.start({ y: 40 });
    gesture.callbacks.update({ translationY: 120 });
    gesture.callbacks.end({ y: 40, translationY: 120 });
    gesture.callbacks.finalize({}, true);
    await Promise.resolve();
  });
  expect(state.moveFolderOrder).toHaveBeenCalledWith('b', 'c');
});

test('마지막 페이지 append 뒤 새 행만 측정되면 기존 geometry를 유지해 다음 drag를 허용한다', async () => {
  const state = {
    data: { items: [folderA, folderB, folderC], nextCursor: 'cursor-2' as string | null },
    loading: false,
    error: null,
    refresh: jest.fn(),
    loadMore: jest.fn(),
    moveFolderOrder: jest.fn().mockResolvedValue(undefined),
    reordering: false,
  };
  mockUsePlannerStarred.mockReturnValue(state);
  const screen = render(<StarredFoldersScreen />);
  for (const [id, y] of [['a', rowY(0)], ['b', rowY(1)], ['c', rowY(2)]] as const) {
    fireEvent(screen.getByTestId(`starred-draggable-task-row-${id}`), 'layout', {
      nativeEvent: { layout: { x: 0, y, width: 320, height: 80 } },
    });
  }

  state.data = { items: [folderA, folderB, folderC, folderD], nextCursor: null };
  screen.rerender(<StarredFoldersScreen />);
  expect(latestGesture('a').enabledValue).toBe(false);
  fireEvent(screen.getByTestId('starred-draggable-task-row-d'), 'layout', {
    nativeEvent: { layout: { x: 0, y: rowY(3), width: 320, height: 80 } },
  });

  expect(latestGesture('a').enabledValue).toBe(true);
  const gesture = latestGesture('a');
  await act(async () => {
    gesture.callbacks.start({ y: 40 });
    gesture.callbacks.update({ translationY: 190 });
    gesture.callbacks.end({ y: 40, translationY: 190 });
    gesture.callbacks.finalize({}, true);
    await Promise.resolve();
  });
  expect(state.moveFolderOrder).toHaveBeenCalledWith('a', 'd');
});

test('행이 이동 중 변환돼도 시작 위치와 translation으로 drop target을 계산한다', async () => {
  const state = {
    data: { items: [folderA, folderB, folderC], nextCursor: null },
    loading: false,
    error: null,
    refresh: jest.fn(),
    loadMore: jest.fn(),
    moveFolderOrder: jest.fn().mockResolvedValue(undefined),
    reordering: false,
  };
  mockUsePlannerStarred.mockReturnValue(state);
  const screen = render(<StarredFoldersScreen />);
  for (const [id, y] of [['a', rowY(0)], ['b', rowY(1)], ['c', rowY(2)]] as const) {
    fireEvent(screen.getByTestId(`starred-draggable-task-row-${id}`), 'layout', {
      nativeEvent: { layout: { x: 0, y, width: 320, height: 80 } },
    });
  }

  const gesture = latestGesture('a');
  await act(async () => {
    gesture.callbacks.start({ y: 40 });
    gesture.callbacks.update({ translationY: 90 });
    // A translated detector can report a different local y at release. The stable
    // drag position is row top + initial local offset + total translation.
    gesture.callbacks.end({ y: -50, translationY: 90 });
    gesture.callbacks.finalize({}, true);
    await Promise.resolve();
  });

  expect(state.moveFolderOrder).toHaveBeenCalledWith('a', 'c');
  expect(mockOpenFolderMenu).not.toHaveBeenCalled();
});

test('threshold를 넘은 뒤 원위치로 돌아와 놓아도 context menu로 바뀌지 않는다', async () => {
  const state = {
    data: { items: [folderA, folderB], nextCursor: null },
    loading: false,
    error: null,
    refresh: jest.fn(),
    loadMore: jest.fn(),
    moveFolderOrder: jest.fn().mockResolvedValue(undefined),
    reordering: false,
  };
  mockUsePlannerStarred.mockReturnValue(state);
  const screen = render(<StarredFoldersScreen />);
  for (const [id, y] of [['a', rowY(0)], ['b', rowY(1)]] as const) {
    fireEvent(screen.getByTestId(`starred-draggable-task-row-${id}`), 'layout', {
      nativeEvent: { layout: { x: 0, y, width: 320, height: 80 } },
    });
  }

  const gesture = latestGesture('a');
  await act(async () => {
    gesture.callbacks.start({ y: 40 });
    gesture.callbacks.update({ translationY: 9 });
    gesture.callbacks.update({ translationY: 0 });
    gesture.callbacks.end({ y: 40, translationY: 0 });
    gesture.callbacks.finalize({}, true);
    await Promise.resolve();
  });

  expect(mockOpenFolderMenu).not.toHaveBeenCalled();
  expect(state.moveFolderOrder).toHaveBeenCalledWith('a', 'b');
});
