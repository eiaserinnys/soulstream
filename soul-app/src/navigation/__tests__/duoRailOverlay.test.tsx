jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
jest.mock('@expo/vector-icons/MaterialCommunityIcons', () => 'MaterialCommunityIcons');
jest.mock('@react-navigation/native-stack', () => ({
  createNativeStackNavigator: require('./navigationCaptureMock').createNativeStackNavigatorCapture,
}));
jest.mock('@react-navigation/bottom-tabs', () => ({
  createBottomTabNavigator: require('./navigationCaptureMock').createBottomTabNavigatorCapture,
}));
jest.mock('@react-navigation/native', () => ({
  ...jest.requireActual('@react-navigation/native'),
  useIsFocused: () => true,
}));
jest.mock('../../hooks/useSessionsStream', () => ({ useSessionsStream: jest.fn() }));
jest.mock('../../hooks/useNodeConnectivityStream', () => ({ useNodeConnectivityStream: jest.fn() }));
jest.mock('../../components/persistent/usePasContextMenu', () => ({
  usePasContextMenu: () => ({ items: () => [], title: undefined, show: jest.fn() }),
}));
jest.mock('../../components/AppKeyboardAvoidingView', () => {
  const ReactModule = require('react');
  const { View } = require('react-native');
  return { AppKeyboardAvoidingView: ({ children, ...props }: Record<string, unknown>) => ReactModule.createElement(View, props, children) };
});
jest.mock('../../screens/DailyPlannerScreen', () => {
  const ReactModule = require('react');
  return { DailyPlannerScreen: ReactModule.forwardRef(() => null) };
});
jest.mock('../../screens/StarredFoldersScreen', () => ({ StarredFoldersScreen: () => null }));
jest.mock('../../screens/ProjectListScreen', () => ({
  ProjectHeaderAddButton: () => null,
  ProjectListScreen: () => null,
  useCreateProject: () => jest.fn(),
}));
jest.mock('../../screens/SessionFeedScreen', () => ({ SessionFeedScreen: () => null }));
jest.mock('../../screens/SearchScreen', () => ({ SearchScreen: () => null }));
jest.mock('../../screens/ChatScreen', () => ({ ChatScreen: () => null }));
jest.mock('../../screens/SettingsScreen', () => ({ SettingsScreen: () => null, FirstConnectionSettingsScreen: () => null }));
jest.mock('../../screens/RecurringJobsScreen', () => ({ RecurringJobsScreen: () => null }));
jest.mock('../../screens/RecurringJobEditorScreen', () => ({ RecurringJobEditorScreen: () => null }));
jest.mock('../../screens/RecurringJobHistoryScreen', () => ({ RecurringJobHistoryScreen: () => null }));
jest.mock('../../components/planner/FolderWorkspace', () => ({ FolderWorkspace: () => null }));
jest.mock('../phonePanelHistory', () => ({
  PhonePanelHistoryProvider: ({ children }: { children: unknown }) => children,
  usePhonePanelHistory: () => ({ recordFocus: jest.fn(), getReturnTab: () => 'FeedTab', hasReturnTab: () => false }),
}));

import React from 'react';
import { StyleSheet, View } from 'react-native';
import { render } from '@testing-library/react-native';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';
import { NavigationContainer } from '@react-navigation/native';
import { DuoSideBandContext } from '../tabContract';
import { PhonePanelHistoryProvider } from '../phonePanelHistory';
import { PersistentSessionProvider } from '../PersistentSessionContext';
import { TabNavigator } from '../TabNavigator';
import { getBottomTabCaptures, getNativeStackCaptures, resetNavigationCapture } from './navigationCaptureMock';

const DUO_INSETS = { top: 24, bottom: 24, left: 0, right: 84 };
const NON_DUO_RAIL_INSETS = { top: 0, bottom: 24, left: 59, right: 59 };

beforeEach(() => {
  resetNavigationCapture();
});

function renderNavigator(insets: typeof DUO_INSETS, duoSideBand: boolean) {
  return render(
    <SafeAreaInsetsContext.Provider value={insets}>
      <DuoSideBandContext.Provider value={duoSideBand}>
        <PersistentSessionProvider><TabNavigator /></PersistentSessionProvider>
      </DuoSideBandContext.Provider>
    </SafeAreaInsetsContext.Provider>,
  );
}

function tabs() {
  return getBottomTabCaptures()[0]!;
}

function railProps(insets: typeof DUO_INSETS) {
  return {
    state: { index: 0, key: 'tab', routes: [{ key: 'daily', name: 'DailyTab' }] },
    descriptors: { daily: { options: {} } },
    navigation: { emit: () => ({ defaultPrevented: false }), dispatch: jest.fn() },
    insets,
  };
}

function renderRail(tabBar: (props: ReturnType<typeof railProps>) => React.ReactElement, insets: typeof DUO_INSETS) {
  return render(
    <SafeAreaInsetsContext.Provider value={insets}>
      <DuoSideBandContext.Provider value={true}>
        <NavigationContainer>
          <PersistentSessionProvider>
            <PhonePanelHistoryProvider>{tabBar(railProps(insets))}</PhonePanelHistoryProvider>
          </PersistentSessionProvider>
        </NavigationContainer>
      </DuoSideBandContext.Provider>
    </SafeAreaInsetsContext.Provider>,
  );
}

test('듀오 레일 루트는 장면 위에 뜨고 듀오가 아닌 railMode에서는 흐름 안에 남는다', () => {
  const duo = renderNavigator(DUO_INSETS, true);
  const duoRail = renderRail(tabs().navigatorProps!.tabBar as (props: ReturnType<typeof railProps>) => React.ReactElement, DUO_INSETS);
  const rail = duoRail.getByTestId('phone-rail-tab-rail');
  const style = StyleSheet.flatten(rail.props.style) ?? {};
  expect(style).toMatchObject({ position: 'absolute', top: 0, right: 0, bottom: 0, zIndex: 1, width: 84 });
  expect(rail.props.pointerEvents).toBe('box-none');
  duoRail.unmount();
  duo.unmount();

  const nonDuo = renderNavigator(NON_DUO_RAIL_INSETS, false);
  const nonDuoRail = renderRail(tabs().navigatorProps!.tabBar as (props: ReturnType<typeof railProps>) => React.ReactElement, NON_DUO_RAIL_INSETS);
  const flowRail = nonDuoRail.getByTestId('phone-rail-tab-rail');
  expect(StyleSheet.flatten(flowRail.props.style)).toMatchObject({ position: 'relative', width: 59 });
  expect(flowRail.props.pointerEvents).toBeUndefined();
  nonDuoRail.unmount();
  nonDuo.unmount();
});

function reserveCount(element: React.ReactElement): number {
  const screen = render(<PersistentSessionProvider>{element}</PersistentSessionProvider>);
  const count = screen.UNSAFE_getAllByType(View)
    .filter((node) => (StyleSheet.flatten(node.props.style) ?? {}).paddingRight === 84).length;
  screen.unmount();
  return count;
}

test('DailyTab 루트는 레일 폭을 비우지 않고 다른 탭과 데일리 하위 화면은 비운다', () => {
  const navigator = renderNavigator(DUO_INSETS, true);
  const tabsLayout = tabs().navigatorProps!.screenLayout as (args: Record<string, unknown>) => React.ReactElement;
  const dailyComponent = tabs().screens.find((screen) => screen.name === 'DailyTab')!.component as React.ComponentType;
  const daily = render(<PersistentSessionProvider><PhonePanelHistoryProvider>{React.createElement(dailyComponent)}</PhonePanelHistoryProvider></PersistentSessionProvider>);
  const dailyCapture = getNativeStackCaptures().find((capture) => capture.screens.some((screen) => screen.name === 'DailyHistory'))!;
  const dailyLayout = dailyCapture.navigatorProps!.screenLayout as (args: Record<string, unknown>) => React.ReactElement;
  expect(dailyLayout).toEqual(expect.any(Function));

  const children = (route: string, inner: React.ReactElement) => dailyLayout({ route: { name: route }, children: inner });
  expect(reserveCount(tabsLayout({ route: { name: 'DailyTab' }, children: children('Daily', <View testID="daily-probe" />) }))).toBe(0);
  expect(reserveCount(tabsLayout({ route: { name: 'DailyTab' }, children: children('CardDetail', <View testID="detail-probe" />) }))).toBe(1);
  expect(reserveCount(tabsLayout({ route: { name: 'FolderTab' }, children: <View testID="folder-probe" /> }))).toBe(1);

  daily.unmount();
  navigator.unmount();
});
