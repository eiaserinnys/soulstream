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

beforeEach(() => {
  useSettingsStore.setState({ serverUrl: 'https://planner.test' });
  useSessionStore.setState({ catalog: { folders: [], sessions: {} } });
});

test('iPad 사이드바의 설정은 중앙 섹션을 바꾸지 않고 모달을 연다', () => {
  const screen = render(<SidebarPane />);
  fireEvent.press(screen.getByText('설정'));
  expect(screen.getByTestId('settings-modal')).toBeTruthy();
});
