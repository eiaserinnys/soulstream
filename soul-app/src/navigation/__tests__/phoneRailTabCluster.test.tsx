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
import { StyleSheet } from 'react-native';
import { fireEvent, render } from '@testing-library/react-native';
import { NavigationContainer } from '@react-navigation/native';
import { PhoneRailTabCluster, RAIL_MIN_INSET_WIDTH } from '../TabNavigator';
import { RailCapsule, RailCapsuleItem } from '../../components/navigation/RailCapsule';
import { PhoneRailModeContext } from '../tabContract';

test('compact 레일은 캡슐 안 항목 높이를 최소 터치 높이로 줄인다', () => {
  const compactProps = { compact: true };
  const screen = render(
    <PhoneRailModeContext.Provider value>
      <NavigationContainer>
        <RailCapsule {...compactProps} testID="compact-rail">
          <RailCapsuleItem testID="compact-rail-item" label="탭" onPress={jest.fn()} badge={2}>
            <></>
          </RailCapsuleItem>
        </RailCapsule>
      </NavigationContainer>
    </PhoneRailModeContext.Provider>,
  );

  expect(StyleSheet.flatten(screen.getByTestId('compact-rail-item').props.style).height).toBe(44);
  expect(StyleSheet.flatten(screen.getByTestId('compact-rail-item-badge').props.style)).toMatchObject({ top: 4, right: 8 });
});

test('레일 탭 클러스터는 5개 루트 탭을 같은 testID로 노출한다', () => {
  const onSelect = jest.fn();
  const screen = render(
    <NavigationContainer>
      <PhoneRailTabCluster active="DailyTab" onSelect={onSelect} />
    </NavigationContainer>,
  );

  expect(RAIL_MIN_INSET_WIDTH).toBe(48);
  expect(screen.getByTestId('phone-rail-tab-cluster')).toBeTruthy();
  expect(StyleSheet.flatten(screen.getByTestId('phone-tab-DailyTab').props.style).height).toBe(50);
  for (const name of ['DailyTab', 'FolderTab', 'PersistentTab', 'FeedTab', 'SettingsTab']) {
    expect(screen.getByTestId(`phone-tab-${name}`)).toBeTruthy();
  }
  expect(screen.getByTestId('phone-tab-PersistentTab').props.accessibilityLabel).toBe('영구 세션 열기');
  expect(screen.getByTestId('phone-tab-DailyTab').props.accessibilityState).toMatchObject({ selected: true });
  expect(screen.getByTestId('phone-tab-FeedTab').props.accessibilityState).toMatchObject({ selected: false });

  fireEvent.press(screen.getByTestId('phone-tab-FeedTab'));
  expect(onSelect).toHaveBeenCalledWith('FeedTab');
});

test('compact PAS 레일 설정이 탭 항목까지 전달된다', () => {
  const screen = render(
    <PhoneRailModeContext.Provider value>
      <NavigationContainer>
        <PhoneRailTabCluster active="DailyTab" onSelect={jest.fn()} duoSideBand compact />
      </NavigationContainer>
    </PhoneRailModeContext.Provider>,
  );

  expect(StyleSheet.flatten(screen.getByTestId('phone-tab-DailyTab').props.style).height).toBe(44);
});

test('PAS 탭이 활성이고 대화 장면이면 카드 목록 보기로 안내한다', () => {
  const screen = render(
    <NavigationContainer>
      <PhoneRailTabCluster active="PersistentTab" onSelect={jest.fn()} />
    </NavigationContainer>,
  );

  expect(screen.getByTestId('phone-tab-PersistentTab').props.accessibilityLabel).toBe('카드 목록 보기');
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
