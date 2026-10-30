jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
jest.mock('@expo/vector-icons/MaterialCommunityIcons', () => 'MaterialCommunityIcons');
const mockShowMenu = jest.fn();
const mockSetSettingsOpen = jest.fn();
jest.mock('../../components/menus/AppContextMenu', () => ({ showAppContextMenu: (...args: unknown[]) => mockShowMenu(...args) }));
jest.mock('../PersistentSessionContext', () => ({
  usePersistentSessionHost: () => ({ loading: false, portrait: null }),
  usePersistentSessionScene: (select: (state: any) => unknown) => select({ scene: 'conversation', session: { agent_name: '서소영' }, setSettingsOpen: mockSetSettingsOpen }),
}));

import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import { NavigationContainer } from '@react-navigation/native';
import { PhoneRailTabCluster, RAIL_MIN_INSET_WIDTH } from '../TabNavigator';
import { Platform } from 'react-native';
import { hasDuoSideBand } from '../tabContract';

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
  expect(screen.getByTestId('phone-tab-PersistentTab').props.accessibilityLabel).toBe('영구 세션 열기');
  expect(screen.getByTestId('phone-tab-DailyTab').props.accessibilityState).toMatchObject({ selected: true });
  expect(screen.getByTestId('phone-tab-FeedTab').props.accessibilityState).toMatchObject({ selected: false });

  fireEvent.press(screen.getByTestId('phone-tab-FeedTab'));
  expect(onSelect).toHaveBeenCalledWith('FeedTab');
});

test('PAS 탭이 활성이고 대화 장면이면 카드 목록 보기로 안내한다', () => {
  const screen = render(
    <NavigationContainer>
      <PhoneRailTabCluster active="PersistentTab" onSelect={jest.fn()} />
    </NavigationContainer>,
  );

  expect(screen.getByTestId('phone-tab-PersistentTab').props.accessibilityLabel).toBe('카드 목록 보기');
});

test('듀오 띠는 iOS의 오른쪽 비대칭 안전 영역에서만 감지한다', () => {
  const original = Platform.OS;
  Object.defineProperty(Platform, 'OS', { value: 'ios', configurable: true });
  const insets = { top: 24, bottom: 24, left: 0, right: 84 };
  expect(hasDuoSideBand(insets)).toBe(true);
  expect(hasDuoSideBand({ ...insets, left: 59, right: 59 })).toBe(false);
  expect(hasDuoSideBand({ ...insets, right: 0 })).toBe(false);
  Object.defineProperty(Platform, 'OS', { value: original, configurable: true });
});

test('PAS 메뉴는 듀오 띠에서 PAS 탭이 활성일 때만 보인다', () => {
  const onSelect = jest.fn();
  const screen = render(<NavigationContainer>
    <PhoneRailTabCluster active="PersistentTab" onSelect={onSelect} duoSideBand />
  </NavigationContainer>);
  expect(screen.getByLabelText('PAS 메뉴')).toBeTruthy();
  fireEvent.press(screen.getByLabelText('PAS 메뉴'));
  expect(mockShowMenu).toHaveBeenCalledWith(expect.arrayContaining([
    expect.objectContaining({ label: '밝기 전환' }),
    expect.objectContaining({ label: '영구 세션 설정' }),
  ]), '서소영');
  mockShowMenu.mock.calls.at(-1)?.[0].find((action: any) => action.label === '영구 세션 설정').onSelect();
  expect(mockSetSettingsOpen).toHaveBeenCalledWith(true);
  screen.rerender(<NavigationContainer>
    <PhoneRailTabCluster active="DailyTab" onSelect={onSelect} duoSideBand />
  </NavigationContainer>);
  expect(screen.queryByLabelText('PAS 메뉴')).toBeNull();
  screen.rerender(<NavigationContainer>
    <PhoneRailTabCluster active="PersistentTab" onSelect={onSelect} duoSideBand={false} />
  </NavigationContainer>);
  expect(screen.queryByLabelText('PAS 메뉴')).toBeNull();
});
