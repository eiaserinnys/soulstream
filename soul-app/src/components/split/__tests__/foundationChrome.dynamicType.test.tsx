jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: require('react-native').View,
  useSafeAreaInsets: () => ({ top: 24, bottom: 20, left: 0, right: 0 }),
}));
let mockDimensions = { width: 1024, height: 1366, scale: 2, fontScale: 1 };
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: () => mockDimensions,
}));
jest.mock('../../../screens/DailyPlannerScreen', () => ({ DailyPlannerScreen: () => null }));
jest.mock('../../../screens/SessionFeedScreen', () => ({ SessionFeedScreen: () => null }));
jest.mock('../../planner/FolderWorkspaceReadOverlay', () => ({ FolderWorkspaceReadOverlay: () => null }));
jest.mock('../../planner/FolderWorkspace', () => ({
  FolderWorkspace: ({ folderId, onOpenFolder }: {
    folderId: string;
    onOpenFolder(folderId: string, pageId: string, name: string): void;
  }) => require('react').createElement(require('react-native').TouchableOpacity, {
    testID: `folder-workspace-${folderId}`,
    onPress: () => onOpenFolder('child', 'child-page', '하위 폴더'),
  }),
}));
jest.mock('../../../hooks/usePlannerReads', () => ({
  usePlannerDailyHistory: () => ({ dates: [] }),
  usePlannerStarred: () => ({ data: { items: [], nextCursor: null }, loading: false, error: null, loadMore: jest.fn() }),
}));
jest.mock('../../../hooks/usePlannerActions', () => ({ usePlannerActions: () => ({}) }));
jest.mock('../../../hooks/usePlannerContextMenus', () => ({ usePlannerContextMenus: () => ({}) }));
jest.mock('../../../screens/SettingsScreen', () => ({ SettingsScreen: () => null }));

import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { StyleSheet } from 'react-native';
import { fireEvent, render } from '@testing-library/react-native';
import { MainListPane } from '../MainListPane';
import { ThreePaneLayout } from '../ThreePaneLayout';
import { TwoPaneWithDrawer } from '../TwoPaneWithDrawer';
import { useSessionStore } from '../../../store/sessionStore';
import { useUIStore } from '../../../store/uiStore';

beforeEach(() => {
  useSessionStore.setState({ catalog: { folders: [], sessions: {} } });
  useUIStore.setState({
    activeSection: { kind: 'daily', date: '2026-07-20' },
    mainPaneViews: { global: 'board' },
    paneLeftWidth: 280,
    paneMiddleWidth: 420,
  });
});

test.each([1, 2])('iPad fontScale %s custom headers keep one-line tail, semantic baseline, action and inset', (fontScale) => {
  mockDimensions = { ...mockDimensions, fontScale };
  const main = render(<MainListPane onMenuPress={jest.fn()} />);
  fireEvent.press(main.getByLabelText('데일리 기록'));
  const mainHeader = StyleSheet.flatten(main.getByTestId('tablet-main-header').props.style);
  const mainTitle = main.getByTestId('root-header-title-DailyTab');
  const mainIcon = main.getByTestId('root-header-icon-DailyTab');
  const menu = main.getByLabelText('메뉴');
  const review = main.getByLabelText('오늘 작업 검토');
  const create = main.getByLabelText('새 작업');

  expect(mainHeader.height).toBeUndefined();
  expect(mainHeader.minHeight).toBe(60);
  expect(mainHeader.paddingHorizontal).toBe(20);
  expect(mainHeader.paddingVertical).toBe(6);
  expect(mainTitle.props.numberOfLines).toBe(1);
  expect(mainTitle.props.ellipsizeMode).toBe('tail');
  expect(mainTitle.props.allowFontScaling).not.toBe(false);
  expect(mainTitle.props.maxFontSizeMultiplier).toBe(2);
  expect(mainIcon.props.allowFontScaling).toBe(true);
  expect(mainIcon.props.maxFontSizeMultiplier).toBe(2);
  expect(mainIcon.props.size).toBe(20);
  expect(StyleSheet.flatten(mainTitle.props.style)).toEqual(expect.objectContaining({
    fontSize: 20,
    lineHeight: 26,
    fontWeight: '600',
  }));
  const menuStyle = StyleSheet.flatten(menu.props.style);
  expect(menuStyle.minWidth).toBeGreaterThanOrEqual(48);
  expect(menuStyle.minHeight).toBeGreaterThanOrEqual(48);
  for (const action of [review, create]) {
    const actionStyle = StyleSheet.flatten(action.props.style);
    expect(actionStyle.minWidth).toBeGreaterThanOrEqual(48);
    expect(actionStyle.minHeight).toBeGreaterThanOrEqual(48);
  }
  main.unmount();

  for (const Layout of [ThreePaneLayout, TwoPaneWithDrawer]) {
    const feed = render(<Layout />);
    const feedHeader = StyleSheet.flatten(feed.getByTestId('tablet-feed-header').props.style);
    const feedTitle = feed.getByTestId('root-header-title-FeedTab');
    const feedIcon = feed.getByTestId('root-header-icon-FeedTab');
    expect(feedHeader.height).toBeUndefined();
    expect(feedHeader.minHeight).toBe(60);
    expect(feedHeader.paddingHorizontal).toBe(20);
    expect(feedHeader.paddingVertical).toBe(6);
    expect(feedTitle.props.numberOfLines).toBe(1);
    expect(feedTitle.props.ellipsizeMode).toBe('tail');
    expect(feedTitle.props.allowFontScaling).not.toBe(false);
    expect(feedTitle.props.maxFontSizeMultiplier).toBe(2);
    expect(feedIcon.props.maxFontSizeMultiplier).toBe(2);
    expect(StyleSheet.flatten(feedTitle.props.style)).toEqual(expect.objectContaining({
      fontSize: 20,
      lineHeight: 26,
      fontWeight: '600',
    }));
    feed.unmount();
  }

});

test('portrait와 landscape layout은 하나의 session feed chrome 구현을 공유한다', () => {
  const threePane = read('../ThreePaneLayout.tsx');
  const twoPane = read('../TwoPaneWithDrawer.tsx');

  for (const source of [threePane, twoPane]) {
    expect(source).toContain('<TabletSessionFeedPane />');
    expect(source).not.toContain('tablet-feed-header');
    expect(source).not.toContain('<SessionFeedScreen');
  }
});

test('태블릿 트리 선택과 화면 안 폴더 이동이 같은 activeSection을 갱신한다', () => {
  useSessionStore.setState({ catalog: { folders: [
    { id: 'parent', name: '상위 폴더', projectPageId: 'parent-page', sortOrder: 0 },
    { id: 'child', name: '하위 폴더', projectPageId: 'child-page', parentFolderId: 'parent', sortOrder: 0 },
  ], sessions: {} } });
  useUIStore.getState().setActiveSection({ kind: 'project', folderId: 'parent', projectPageId: 'parent-page' });

  const screen = render(<MainListPane />);
  expect(screen.getByTestId('folder-workspace-parent')).toBeTruthy();
  fireEvent.press(screen.getByTestId('folder-workspace-parent'));
  expect(useUIStore.getState().activeSection).toEqual({
    kind: 'project', folderId: 'child', projectPageId: 'child-page',
  });
  expect(screen.getByTestId('folder-workspace-child')).toBeTruthy();
});

function read(relativePath: string): string {
  return fs.readFileSync(path.resolve(__dirname, relativePath), 'utf8');
}
