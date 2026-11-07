jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
jest.mock('@expo/vector-icons/MaterialCommunityIcons', () => 'MaterialCommunityIcons');
jest.mock('expo-web-browser', () => ({ openBrowserAsync: jest.fn() }));
jest.mock('../../api/client', () => ({ createApiClient: () => null }));
jest.mock('../../components/planner/TodayCardComposer', () => ({ TodayCardComposer: () => null }));
jest.mock('../../components/planner/CardBoardWorkspace', () => {
  const ReactModule = require('react');
  const { View } = require('react-native');
  return {
    CardBoardWorkspace: ReactModule.forwardRef((props: Record<string, unknown>, _ref: unknown) =>
      ReactModule.createElement(View, { testID: 'card-board-workspace-mock', ...props })),
  };
});
import React from 'react';
import { StyleSheet } from 'react-native';
import { render } from '@testing-library/react-native';
import { CardHomeScreen } from '../CardHomeScreen';
import { useSettingsStore } from '../../store/settingsStore';

test('레일 위로 뜬 화면은 도크를 레일 폭만큼 안쪽으로 물리고 자기 겹침 경계를 만든다', () => {
  useSettingsStore.setState({ serverUrl: 'https://test.example' });
  const screen = render(<CardHomeScreen railOverlayWidth={84} onOpen={() => {}} />);

  const dock = StyleSheet.flatten(screen.getByTestId('home-session-composer-dock').props.style);
  expect(dock.left).toBe(16);
  expect(dock.right).toBe(100);
  expect(StyleSheet.flatten(screen.getByTestId('card-home-content').props.style).isolation).toBe('isolate');
  expect(screen.getByTestId('card-board-workspace-mock').props.railOverlayWidth).toBe(84);
});
