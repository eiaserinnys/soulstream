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
import { act, fireEvent, render } from '@testing-library/react-native';
import { NavigationContainer } from '@react-navigation/native';
import { PhoneRailTabCluster, RAIL_MIN_INSET_WIDTH } from '../TabNavigator';
import { StyleSheet } from 'react-native';
import { usePhoneRailActions, useRegisterDuoRailOverride } from '../phoneRailActions';
import { PhoneRailModeContext } from '../tabContract';
import { RailCapsule, RailCapsuleItem } from '../../components/navigation/RailCapsule';
import { Text } from 'react-native';

test('숫자와 점의 우선순위와 비활성 상태를 노출한다', () => {
  const onPress = jest.fn();
  const disabledPress = jest.fn();
  const screen = render(<NavigationContainer><RailCapsule testID="badge-capsule" compact>
    <RailCapsuleItem testID="count" label="확인 항목" badgeCount={3} dot onPress={onPress}><Text>아이콘</Text></RailCapsuleItem>
    <RailCapsuleItem testID="dot" label="커멘트" dot disabled onPress={disabledPress}><Text>아이콘</Text></RailCapsuleItem>
  </RailCapsule></NavigationContainer>);
  expect(screen.getByTestId('count-badge')).toBeTruthy();
  expect(screen.queryByTestId('count-dot')).toBeNull();
  expect(screen.getByTestId('dot-dot')).toBeTruthy();
  expect(screen.getByLabelText('커멘트').props.accessibilityState.disabled).toBe(true);
});

test('상세 레일은 마지막 오버레이를 우선하고 닫으면 이전 레일로 돌아간다', () => {
  const open = jest.fn();
  function Override({ id, count }: { id: string; count?: number }) {
    useRegisterDuoRailOverride(id, true, [{ id, label: id, icon: 'close', badgeCount: count, onPress: open }]);
    return null;
  }
  function Scene({ inner }: { inner: boolean }) {
    return <NavigationContainer><Override id="folder" />{inner ? <Override id="card" count={3} /> : null}
      <PhoneRailTabCluster active="DailyTab" onSelect={jest.fn()} duoSideBand />
    </NavigationContainer>;
  }
  const screen = render(<Scene inner={false} />);
  expect(screen.getByTestId('phone-rail-action-folder')).toBeTruthy();
  expect(screen.queryByTestId('phone-tab-DailyTab')).toBeNull();
  screen.rerender(<Scene inner />);
  expect(screen.getByTestId('phone-rail-action-card')).toBeTruthy();
  expect(screen.getByText('3')).toBeTruthy();
  fireEvent.press(screen.getByTestId('phone-rail-action-card'));
  expect(open).toHaveBeenCalledTimes(1);
  screen.rerender(<Scene inner={false} />);
  expect(screen.getByTestId('phone-rail-action-folder')).toBeTruthy();
});

test('활성 루트의 동작을 탭보다 앞에 표시하고 호출한다', () => {
  const create = jest.fn();
  usePhoneRailActions.getState().setActions('DailyTab', [
    { id: 'create', label: '드래프트 카드 추가', icon: 'add-outline', onPress: create },
  ]);
  const screen = render(<NavigationContainer><PhoneRailTabCluster active="DailyTab" onSelect={jest.fn()} duoSideBand /></NavigationContainer>);
  fireEvent.press(screen.getByLabelText('드래프트 카드 추가'));
  expect(create).toHaveBeenCalledTimes(1);
  screen.rerender(<NavigationContainer><PhoneRailTabCluster active="FeedTab" onSelect={jest.fn()} duoSideBand /></NavigationContainer>);
  expect(screen.queryByLabelText('드래프트 카드 추가')).toBeNull();
  act(() => usePhoneRailActions.getState().setActions('DailyTab', undefined));
});

test('compact 레일은 모든 탭 칸에 최소 터치 높이를 쓴다', () => {
  const screen = render(<NavigationContainer><PhoneRailModeContext.Provider value={true}>
    <PhoneRailTabCluster active="DailyTab" onSelect={jest.fn()} compact />
  </PhoneRailModeContext.Provider></NavigationContainer>);
  for (const name of ['DailyTab', 'FolderTab', 'PersistentTab', 'FeedTab', 'SettingsTab']) {
    expect(StyleSheet.flatten(screen.getByTestId(`phone-tab-${name}`).props.style).height).toBe(44);
  }
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
