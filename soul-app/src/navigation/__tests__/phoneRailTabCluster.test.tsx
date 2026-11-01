jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
jest.mock('@expo/vector-icons/MaterialCommunityIcons', () => 'MaterialCommunityIcons');
const mockShowMenu = jest.fn();
const mockSetSettingsOpen = jest.fn();
jest.mock('../../components/menus/AppContextMenu', () => ({ showAppContextMenu: (...args: unknown[]) => mockShowMenu(...args) }));
jest.mock('../PersistentSessionContext', () => ({
  usePersistentSessionHost: () => ({ loading: false, portrait: null, store: { getState: () => ({
    session: null, leave: jest.fn(), swipe: jest.fn(), selectCard: jest.fn(), toggleReports: jest.fn(),
  }) } }),
  usePersistentSessionScene: (select: (state: any) => unknown) => select({ scene: 'conversation', session: { agent_name: '서소영' }, selectedCardId: null,
    reportCount: 0, hasReports: false, setSettingsOpen: mockSetSettingsOpen }),
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
import { DuoRailOverride } from '../../components/navigation/DuoRailOverride';
import { AppKeyboardAvoidingView } from '../../components/AppKeyboardAvoidingView';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';

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

test('듀오 레일은 백·현재 화면 조작·전체 내비게이션을 한 48pt 열에 둔다', () => {
  function Override({ single }: { single: boolean }) {
    useRegisterDuoRailOverride('detail', true, [
      { id: 'back', label: '뒤로', icon: 'chevron-back', onPress: jest.fn() },
      ...(single ? [] : [{ id: 'edit', label: '편집', icon: 'pencil' as const, onPress: jest.fn() }]),
    ]);
    return null;
  }
  const scene = (single: boolean) => <NavigationContainer><Override single={single} />
    <PhoneRailTabCluster active="DailyTab" onSelect={jest.fn()} duoSideBand />
  </NavigationContainer>;
  const screen = render(scene(false));
  const column = screen.getByTestId('duo-rail-column');
  expect(StyleSheet.flatten(column.props.style)).toMatchObject({ width: 48, flex: 1, position: 'relative' });
  const columnChildren = React.Children.toArray(column.props.children) as React.ReactElement<{ testID?: string }>[];
  expect(columnChildren.map(child => child.props.testID)).toEqual(['duo-rail-top-stack', 'phone-rail-tab-cluster']);
  expect(screen.getByTestId('duo-rail-back-capsule')).toBeTruthy();
  expect(StyleSheet.flatten(screen.getByTestId('duo-rail-back-capsule').props.style)).toMatchObject({ width: 48, height: 48 });
  expect(screen.getByTestId('phone-rail-action-back')).toBeTruthy();
  expect(StyleSheet.flatten(screen.getByTestId('phone-rail-action-back').props.style)).toMatchObject({ width: 48, height: 48 });
  expect(screen.getByTestId('duo-rail-context-capsule')).toBeTruthy();
  expect(screen.getByTestId('phone-rail-action-edit')).toBeTruthy();
  expect(screen.getByTestId('phone-rail-tab-cluster')).toBeTruthy();
  expect(screen.queryByTestId('phone-tab-DailyTab')).toBeNull();
  for (const name of ['FolderTab', 'PersistentTab', 'FeedTab']) expect(screen.getByTestId(`phone-tab-${name}`)).toBeTruthy();
  screen.rerender(scene(true));
  expect(screen.getByTestId('duo-rail-back-capsule')).toBeTruthy();
  expect(screen.queryByTestId('duo-rail-context-capsule')).toBeNull();
  expect(screen.queryByTestId('phone-rail-action-edit')).toBeNull();
  expect(screen.getByTestId('phone-rail-tab-cluster')).toBeTruthy();
});

test.each(['DailyTab', 'FolderTab', 'PersistentTab', 'FeedTab'] as const)(
  '듀오 레일 하단에서 활성 탭 %s만 제외한다', (active) => {
    const screen = render(<NavigationContainer><PhoneRailTabCluster active={active} onSelect={jest.fn()} duoSideBand /></NavigationContainer>);
    expect(screen.getByTestId('duo-rail-back-capsule')).toBeTruthy();
    expect(screen.getByTestId('phone-rail-tab-cluster')).toBeTruthy();
    expect(screen.queryByTestId(`phone-tab-${active}`)).toBeNull();
    for (const name of ['DailyTab', 'FolderTab', 'PersistentTab', 'FeedTab'] as const) {
      if (name !== active) expect(screen.getByTestId(`phone-tab-${name}`)).toBeTruthy();
    }
  },
);

test('초기 루트의 백버튼은 자리를 유지하고 비활성화된다', () => {
  const screen = render(<NavigationContainer>
    <PhoneRailTabCluster active="DailyTab" onSelect={jest.fn()} duoSideBand />
  </NavigationContainer>);
  expect(screen.getByTestId('duo-rail-back-capsule')).toBeTruthy();
  expect(screen.getByTestId('phone-rail-action-back').props.accessibilityState.disabled).toBe(true);
});

test('루트 하위 탭의 듀오 레일 백버튼은 전달된 복귀 동작을 실행한다', () => {
  const onBack = jest.fn();
  const screen = render(<NavigationContainer>
    <PhoneRailTabCluster active="FolderTab" onSelect={jest.fn()} duoSideBand onBack={onBack} />
  </NavigationContainer>);
  fireEvent.press(screen.getByTestId('phone-rail-action-back'));
  expect(onBack).toHaveBeenCalledTimes(1);
});

test('오버레이 레일도 키보드 위로 올라가고 하단 액션을 제한한다', () => {
  const key = Symbol('overlay');
  const onEdit = jest.fn();
  act(() => usePhoneRailActions.getState().pushOverride(key, [
    { id: 'close', label: '닫기', icon: 'close', onPress: jest.fn() },
    { id: 'edit', label: '편집', icon: 'pencil', onPress: onEdit },
  ]));
  const screen = render(<NavigationContainer><SafeAreaInsetsContext.Provider value={{ top: 24, bottom: 24, left: 0, right: 84 }}>
    <DuoRailOverride />
  </SafeAreaInsetsContext.Provider></NavigationContainer>);
  act(() => screen.UNSAFE_getByType(AppKeyboardAvoidingView).props.onOverlapChange(300));
  const overrideHost = screen.getByTestId('duo-rail-override-host');
  const overrideWrappers = React.Children.toArray(overrideHost.props.children) as React.ReactElement<{ style?: any }>[];
  expect(overrideWrappers).toHaveLength(2);
  for (const wrapper of overrideWrappers) {
    expect(StyleSheet.flatten(wrapper.props.style)).toMatchObject({ left: 0, right: 12, alignItems: 'center' });
  }
  expect(screen.getByTestId('duo-rail-back-capsule')).toBeTruthy();
  expect(StyleSheet.flatten(screen.getByTestId('duo-rail-back-capsule').props.style)).toMatchObject({ width: 48, height: 48 });
  expect(StyleSheet.flatten(screen.getByTestId('duo-rail-action-close').props.style)).toMatchObject({ width: 48, height: 48 });
  const capsule = screen.getByTestId('duo-rail-override');
  expect(capsule).toBeTruthy();
  expect(StyleSheet.flatten(screen.getByTestId('duo-rail-override-lower').props.style).bottom).toBe(300);
  expect(StyleSheet.flatten(screen.getByTestId('duo-rail-override-scroll').props.style).maxHeight).toBeGreaterThanOrEqual(0);
  fireEvent.press(screen.getByTestId('duo-rail-action-edit'));
  expect(onEdit).toHaveBeenCalledTimes(1);
  act(() => usePhoneRailActions.getState().removeOverride(key));
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

test('compact 듀오 레일은 세 컨텍스트 액션 높이에 맞춰 캡슐을 제한한다', () => {
  const dimensions = jest.spyOn(require('react-native'), 'useWindowDimensions').mockReturnValue({
    width: 678, height: 466, scale: 1, fontScale: 1,
  });
  function Override() {
    useRegisterDuoRailOverride('compact-three-actions', true, [
      { id: 'back', label: '뒤로', icon: 'chevron-back', onPress: jest.fn() },
      ...(['one', 'two', 'three'] as const).map((id) => ({ id, label: id, icon: 'ellipse-outline' as const, onPress: jest.fn() })),
    ]);
    return null;
  }
  const screen = render(<NavigationContainer><SafeAreaInsetsContext.Provider value={{ top: 0, bottom: 24, left: 0, right: 84 }}>
    <Override />
    <PhoneRailTabCluster active="DailyTab" onSelect={jest.fn()} duoSideBand compact />
  </SafeAreaInsetsContext.Provider></NavigationContainer>);

  expect(screen.getByTestId('duo-rail-context-scroll').props.style.maxHeight).toBe(136);
  expect(StyleSheet.flatten(screen.getByTestId('duo-rail-top-stack').props.style).gap).toBe(4);
  for (const id of ['one', 'two', 'three']) {
    expect(StyleSheet.flatten(screen.getByTestId(`phone-rail-action-${id}`).props.style).height).toBe(44);
  }

  screen.unmount();
  dimensions.mockRestore();
});

test.each([[true, 4], [false, 8]] as const)('듀오 상단 캡슐 간격은 compact=%s일 때 %ipt다', (compact, gap) => {
  const screen = render(<NavigationContainer>
    <PhoneRailTabCluster active="DailyTab" onSelect={jest.fn()} duoSideBand compact={compact} />
  </NavigationContainer>);
  expect(StyleSheet.flatten(screen.getByTestId('duo-rail-top-stack').props.style).gap).toBe(gap);
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

  expect(StyleSheet.flatten(screen.getByTestId('phone-tab-FolderTab').props.style).height).toBe(44);
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
  expect(screen.getByTestId('phone-rail-pas-menu')).toBeTruthy();
  expect(screen.getByTestId('phone-rail-pas-reports')).toBeTruthy();
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
