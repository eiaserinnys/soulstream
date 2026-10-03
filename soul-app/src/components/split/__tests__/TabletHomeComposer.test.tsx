jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
jest.mock('../SidebarPane', () => ({ SidebarPane: () => null }));
jest.mock('../MainListPane', () => ({ MainListPane: () => null }));
jest.mock('../TabletSessionFeedPane', () => ({ TabletSessionFeedPane: () => null }));
jest.mock('../../planner/FolderWorkspaceReadOverlay', () => ({ FolderWorkspaceReadOverlay: () => null }));
jest.mock('../../planner/TodayCardComposer', () => ({ TodayCardComposer: () => require('react').createElement(require('react-native').View, { testID: 'composer-content' }) }));
import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { ThreePaneLayout } from '../ThreePaneLayout';
import { TwoPaneWithDrawer } from '../TwoPaneWithDrawer';
import { useUIStore } from '../../../store/uiStore';

beforeEach(() => useUIStore.setState({
  activeSection: { kind: 'daily', date: '2026-10-03' }, mainPaneViews: { global: 'board' },
  folderOverlayVisible: false, settingsVisible: false, cardBoardExpanded: false,
  floatingComposerBottomInset: 0,
} as any));

test.each([ThreePaneLayout, TwoPaneWithDrawer])('%p shares a 60% floating host and releases covered height on hiding', Layout => {
  const screen = render(<Layout />);
  const host = screen.getByTestId('tablet-home-composer-host');
  expect(host.props.pointerEvents).toBe('box-none');
  expect(StyleSheet.flatten(host.props.style).position).toBe('absolute');
  const dock = screen.getByTestId('home-session-composer-dock');
  expect(StyleSheet.flatten(dock.props.style).width).toBe('60%');
  fireEvent(dock, 'layout', { nativeEvent: { layout: { height: 100 } } });
  expect((useUIStore.getState() as any).floatingComposerBottomInset).toBe(112);
  act(() => { useUIStore.setState({ settingsVisible: true }); });
  expect(screen.queryByTestId('home-session-composer-dock')).toBeNull();
  expect((useUIStore.getState() as any).floatingComposerBottomInset).toBe(0);
});

test.each([
  { activeSection: { kind: 'project', folderId: 'folder-1', projectPageId: 'page-1' } },
  { mainPaneViews: { global: 'existing' } },
  { folderOverlayVisible: true }, { settingsVisible: true }, { cardBoardExpanded: true },
])('floating composer is absent for %j', state => {
  useUIStore.setState(state as any);
  const screen = render(<ThreePaneLayout />);
  expect(screen.queryByTestId('home-session-composer-dock')).toBeNull();
});
