/** Routers, NavigationContainer and useOpenContentLink are real; only OS views and screen contents are substituted. */
jest.mock('../../../node_modules/@react-navigation/native-stack/lib/module/views/NativeStackView.native.js', () => jest.requireActual('../../../node_modules/@react-navigation/native-stack/lib/module/views/NativeStackView.js'));
jest.mock('react-native-screens', () => {
  const { View } = require('react-native');
  return { Screen: View, ScreenContainer: View, ScreenStack: View, ScreenStackItem: View,
    ScreenStackHeaderConfig: View, screensEnabled: () => false, enableScreens: jest.fn() };
});
jest.mock('../../hooks/useSessionsStream', () => ({ useSessionsStream: jest.fn() }));
jest.mock('../../hooks/useNodeConnectivityStream', () => ({ useNodeConnectivityStream: jest.fn() }));
jest.mock('../../components/UiUsageEventsHost', () => ({ UiUsageEventsHost: () => null }));
jest.mock('../../screens/DailyPlannerScreen', () => ({ DailyPlannerScreen: require('react').forwardRef(() => null) }));
jest.mock('../PhoneCardHome', () => ({ PhoneCardHome: () => require('react').createElement(require('react-native').View, { testID: 'real-daily' }) }));
jest.mock('../../screens/FolderListScreen', () => ({ FolderListScreen: () => require('react').createElement(require('react-native').View, { testID: 'real-folder' }) }));
jest.mock('../../screens/SessionFeedScreen', () => ({ SessionFeedScreen: () => require('react').createElement(require('react-native').View, { testID: 'real-feed' }) }));
jest.mock('../../screens/SearchScreen', () => ({ SearchScreen: () => null }));
jest.mock('../../screens/ChatScreen', () => ({ ChatScreen: () => require('react').createElement(require('react-native').View, { testID: 'real-chat' }) }));
jest.mock('../../screens/SettingsScreen', () => ({ SettingsScreen: () => null }));
jest.mock('../../screens/RecurringJobsScreen', () => ({ RecurringJobsScreen: () => null }));
jest.mock('../../screens/RecurringJobEditorScreen', () => ({ RecurringJobEditorScreen: () => null }));
jest.mock('../../screens/RecurringJobHistoryScreen', () => ({ RecurringJobHistoryScreen: () => null }));
jest.mock('../../components/planner/FolderWorkspace', () => ({ FolderWorkspace: () => null }));
jest.mock('../../components/planner/CardDetailSheet', () => ({ CardDetailContent: ({ cardId }: { cardId?: string }) =>
  require('react').createElement(require('react-native').View, { testID: 'real-card-detail', cardId }) }));
jest.mock('../../components/split/SplitLayout', () => ({ SplitLayout: () => require('react').createElement(require('react-native').View, { testID: 'real-main' }) }));
jest.mock('../../screens/PersistentSessionScreen', () => {
  const React = require('react');
  const { Pressable } = require('react-native');
  const { useOpenContentLink } = require('../../hooks/useOpenContentLink');
  return { PersistentSessionScreen: () => {
    const openLink = useOpenContentLink();
    return React.createElement(Pressable, { testID: 'open-persistent-card', onPress: () => { void openLink('/?card=card-1'); } });
  } };
});
let mockDevice = 'tabletLandscape';
jest.mock('../../theme/useDeviceType', () => ({
  useDeviceType: () => mockDevice,
  deviceTypeToBaseKey: (device: string) => device === 'phone' ? 'phone' : 'tablet',
}));

import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { NavigationContainer, createNavigationContainerRef } from '@react-navigation/native';
import { TabNavigator } from '../TabNavigator';
import { PersistentSessionProvider, usePersistentSessionHost } from '../PersistentSessionContext';
import { TabletNavigator } from '../TabletNavigator';
import { useSettingsStore } from '../../store/settingsStore';

beforeEach(() => {
  mockDevice = 'tabletLandscape';
  useSettingsStore.setState({ serverUrl: 'https://soulstream.test' });
});

test('태블릿에서 PAS 위 카드 열기는 PAS 라우트를 유지하고 그 세션의 카드 오버레이를 연다', async () => {
  const navigation = createNavigationContainerRef<any>();
  let host!: ReturnType<typeof usePersistentSessionHost>;
  function Capture() { host = usePersistentSessionHost(); return null; }
  const view = render(<PersistentSessionProvider><Capture /><NavigationContainer ref={navigation}>
    <TabletNavigator />
  </NavigationContainer></PersistentSessionProvider>);
  await waitFor(() => expect(navigation.isReady()).toBe(true));
  act(() => { host.store.getState().open({ session_id: 'pas-1', persistent: true } as any); navigation.navigate('PersistentSession'); });
  await waitFor(() => expect(navigation.getCurrentRoute()?.name).toBe('PersistentSession'));

  fireEvent.press(view.getByTestId('open-persistent-card'));
  await waitFor(() => expect(host.store.getState().selectedCardId).toBe('card-1'));
  expect(navigation.getCurrentRoute()?.name).toBe('PersistentSession');
  expect(host.store.getState().scene).toBe('conversation');
  view.unmount();
});

test('복원된 Main 위 PAS에서도 카드 열기는 PAS를 떠나지 않는다', async () => {
  const navigation = createNavigationContainerRef<any>();
  let host!: ReturnType<typeof usePersistentSessionHost>;
  function Capture() { host = usePersistentSessionHost(); return null; }
  const view = render(<PersistentSessionProvider><Capture /><NavigationContainer ref={navigation}
    initialState={{ index: 1, routes: [{ name: 'Main' }, { name: 'PersistentSession' }] } as any}>
    <TabletNavigator />
  </NavigationContainer></PersistentSessionProvider>);
  await waitFor(() => expect(navigation.isReady()).toBe(true));
  expect(navigation.getCurrentRoute()?.name).toBe('PersistentSession');

  fireEvent.press(view.getByTestId('open-persistent-card'));
  await waitFor(() => expect(host.store.getState().selectedCardId).toBe('card-1'));
  expect(navigation.getRootState().routes.map(route => route.name)).toEqual(['Main', 'PersistentSession']);
  view.unmount();
});

test('phone PAS 위 카드 열기는 기존처럼 CardDetail을 push한다', async () => {
  mockDevice = 'phone';
  const navigation = createNavigationContainerRef<any>();
  const view = render(<PersistentSessionProvider><NavigationContainer ref={navigation}>
    <TabNavigator initialTab="PersistentTab" />
  </NavigationContainer></PersistentSessionProvider>);
  await waitFor(() => expect(navigation.isReady()).toBe(true));
  await waitFor(() => expect(view.getByTestId('open-persistent-card')).toBeTruthy());

  fireEvent.press(view.getByTestId('open-persistent-card'));
  await waitFor(() => expect(navigation.getCurrentRoute()).toMatchObject({ name: 'CardDetail', params: { cardId: 'card-1' } }));
  const root = navigation.getRootState();
  expect(root.routes[root.index].name).toBe('PersistentTab');
  view.unmount();
});
