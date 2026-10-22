jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
jest.mock('@expo/vector-icons/MaterialCommunityIcons', () => 'MaterialCommunityIcons');
jest.mock('../PersistentSessionContext', () => ({
  usePersistentSessionHost: () => ({ loading: false, portrait: null }),
  usePersistentSessionScene: (select: (state: { scene: string }) => unknown) => select({ scene: 'chat' }),
}));

import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import { NavigationContainer } from '@react-navigation/native';
import { PhoneRailTabCluster, RAIL_MIN_INSET_WIDTH } from '../TabNavigator';

test('레일 탭 클러스터는 5개 루트 탭을 같은 testID로 노출한다', () => {
  const onSelect = jest.fn();
  const screen = render(
    <NavigationContainer>
      <PhoneRailTabCluster active="DailyTab" onSelect={onSelect} />
    </NavigationContainer>,
  );

  expect(RAIL_MIN_INSET_WIDTH).toBe(48);
  expect(screen.getByTestId('phone-rail-tab-cluster')).toBeTruthy();
  for (const name of ['DailyTab', 'FolderTab', 'PersistentTab', 'FeedTab', 'SettingsTab']) {
    expect(screen.getByTestId(`phone-tab-${name}`)).toBeTruthy();
  }
  expect(screen.getByTestId('phone-tab-DailyTab').props.accessibilityState).toMatchObject({ selected: true });
  expect(screen.getByTestId('phone-tab-FeedTab').props.accessibilityState).toMatchObject({ selected: false });

  fireEvent.press(screen.getByTestId('phone-tab-FeedTab'));
  expect(onSelect).toHaveBeenCalledWith('FeedTab');
});
