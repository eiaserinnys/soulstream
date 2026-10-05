import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import { useSessionStore } from '../../../store/sessionStore';
import { useSettingsStore } from '../../../store/settingsStore';

jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
jest.mock('../../settings/SettingsModal', () => ({
  SettingsModal: ({ visible }: { visible: boolean }) => visible
    ? require('react').createElement(require('react-native').View, { testID: 'settings-modal' })
    : null,
}));
jest.mock('../../../hooks/usePlannerReads', () => ({
  usePlannerDailyHistory: () => ({ dates: [], loading: false, error: null }),
  usePlannerStarred: () => ({ data: { items: [], nextCursor: null }, loading: false, error: null }),
}));
jest.mock('../../../hooks/usePlannerActions', () => ({
  usePlannerActions: () => ({ createRootFolder: jest.fn() }),
}));
jest.mock('../../../hooks/usePlannerContextMenus', () => ({
  usePlannerContextMenus: () => ({ openProjectMenu: jest.fn(), openFolderMenu: jest.fn() }),
}));

import { SidebarPane } from '../SidebarPane';
import { useUIStore } from '../../../store/uiStore';
import { StyleSheet } from 'react-native';

test('floating coverage adds scroll space without moving the fixed settings footer', () => {
  useUIStore.setState({ floatingComposerBottomInset: 0 });
  const screen = render(<SidebarPane />);
  const footer = StyleSheet.flatten(screen.getByTestId('sidebar-settings-footer').props.style);
  require('@testing-library/react-native').act(() => { useUIStore.getState().setFloatingComposerBottomInset(112); });
  expect(StyleSheet.flatten(screen.getByTestId('sidebar-main-list').props.contentContainerStyle).paddingBottom).toBe(0);
  expect(StyleSheet.flatten(screen.getByTestId('sidebar-home-composer-spacer').props.style)).toMatchObject({ height: 112, marginTop: -0 });
  expect(StyleSheet.flatten(screen.getByTestId('sidebar-settings-footer').props.style)).toEqual(footer);
});

beforeEach(() => {
  useUIStore.setState({ floatingComposerBottomInset: 0 });
  useSettingsStore.setState({ serverUrl: 'https://planner.test' });
  useSessionStore.setState({ catalog: { folders: [], sessions: {} } });
});

test('iPad 사이드바의 설정은 중앙 섹션을 바꾸지 않고 모달을 연다', () => {
  const screen = render(<SidebarPane />);
  fireEvent.press(screen.getByText('설정'));
  expect(screen.getByTestId('settings-modal')).toBeTruthy();
});
