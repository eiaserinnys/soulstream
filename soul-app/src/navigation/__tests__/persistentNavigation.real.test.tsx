/** Routers and NavigationContainer are real; only OS views and product screen contents are substituted. */
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
jest.mock('../../components/planner/CardDetailSheet', () => ({ CardDetailContent: ({ onOpenSession }: { onOpenSession?: (id: string) => void }) =>
  require('react').createElement(require('react-native').Pressable, {
    testID: 'open-card-session', onPress: () => onOpenSession?.('session-b'),
  }) }));
jest.mock('../../components/split/SplitLayout', () => ({ SplitLayout: () => require('react').createElement(require('react-native').View, { testID: 'real-main' }) }));
jest.mock('../../screens/PersistentSessionScreen', () => ({ PersistentSessionScreen: () => null }));

import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { NavigationContainer, createNavigationContainerRef } from '@react-navigation/native';
import { TabNavigator } from '../TabNavigator';
import { PersistentSessionProvider, usePersistentSessionHost } from '../PersistentSessionContext';
import { TabletNavigator } from '../TabletNavigator';
import { openTabletSessionFromRoot } from '../tabletSessionNavigation';
import { useUIStore } from '../../store/uiStore';
import { openNotificationSession } from '../notificationSessionRoute';
import { openPhoneChat, openPreviousPhonePanel } from '../phoneSessionNavigation';
import { buildPhoneState, readPhoneLocation } from '../layoutNavigationState';

test.each(['DailyTab', 'FolderTab', 'SettingsTab', 'notification'] as const)(
  '미방문 Feed에서 %s 진입은 실제 [Feed, Chat] 스택을 만들고 돌아간 뒤 피드가 살아 있다', async origin => {
    const navigation = createNavigationContainerRef<any>();
    const view = render(<PersistentSessionProvider><NavigationContainer ref={navigation}><TabNavigator /></NavigationContainer></PersistentSessionProvider>);
    await waitFor(() => expect(navigation.isReady()).toBe(true));
    if (origin !== 'notification') act(() => navigation.navigate(origin,
      origin === 'SettingsTab' ? { screen: 'RecurringJobHistory', params: { jobId: 'job' } } : undefined));
    const returnTab = origin === 'notification' ? 'DailyTab' : origin;
    const before = navigation.getRootState();
    expect(before.routes.find(route => route.name === 'FeedTab')?.state).toBeUndefined();
    act(() => {
      if (origin === 'notification') openNotificationSession('phone', 'ordinary-session', id => openPhoneChat({ getParent: () => navigation }, id, undefined, undefined, 'notification'));
      else openPhoneChat({ getParent: () => navigation }, 'ordinary-session');
    });
    await waitFor(() => expect(navigation.getCurrentRoute()?.name).toBe('Chat'));
    const feed = navigation.getRootState().routes.find(route => route.name === 'FeedTab')!.state!;
    expect(feed.routes.map(route => route.name)).toEqual(['Feed', 'Chat']);
    expect(view.getByTestId('real-chat')).toBeTruthy();
    const chat = feed.routes[feed.index!];
    expect(chat.params).toMatchObject({ sessionId: 'ordinary-session', returnTab });
    act(() => { openPreviousPhonePanel({ getParent: () => navigation, goBack: () => navigation.goBack() }, returnTab); });
    await waitFor(() => expect(navigation.getRootState().routes[navigation.getRootState().index].name).toBe(returnTab));
    act(() => navigation.navigate('FeedTab'));
    await waitFor(() => expect(navigation.getCurrentRoute()?.name).toBe('Feed'));
    expect(view.getByTestId('real-feed')).toBeTruthy();
    expect(navigation.getRootState().routes.find(route => route.name === 'FeedTab')!.state!.routes.map(route => route.name)).toEqual(['Feed']);
  },
);

test.each(['DailyTab', 'FolderTab', 'PersistentTab'] as const)(
  '복원된 %s 카드 상세에서 세션을 열면 Feed의 Chat으로 가고 카드로 돌아온다', async origin => {
    const navigation = createNavigationContainerRef<any>();
    const initialState = buildPhoneState({
      originTab: origin,
      kind: 'cardDetail',
      cardId: 'card-a',
      ...(origin === 'PersistentTab' ? { pasCard: true } : {}),
    });
    const view = render(<PersistentSessionProvider><NavigationContainer ref={navigation} initialState={initialState}>
      <TabNavigator />
    </NavigationContainer></PersistentSessionProvider>);
    await waitFor(() => expect(navigation.isReady()).toBe(true));
    expect(navigation.getCurrentRoute()?.name).toBe('CardDetail');
    expect(view.queryByTestId('real-feed')).toBeNull();

    fireEvent.press(view.getByTestId('open-card-session'));
    await waitFor(() => expect(navigation.getCurrentRoute()?.name).toBe('Chat'));
    const root = navigation.getRootState();
    expect(root.routes[root.index!]!.name).toBe('FeedTab');
    const feed = root.routes.find((route: any) => route.name === 'FeedTab')!.state!;
    const chat = feed.routes[feed.index!]!;
    expect(chat).toMatchObject({ name: 'Chat', params: { sessionId: 'session-b', returnTab: origin } });
    expect(readPhoneLocation(root)).toMatchObject({ kind: 'chat', cardId: 'card-a' });

    act(() => openPreviousPhonePanel({ getParent: () => navigation, goBack: () => navigation.goBack() }, origin));
    await waitFor(() => expect(navigation.getCurrentRoute()?.name).toBe('CardDetail'));
    const stateAfterBack = navigation.getRootState();
    expect(stateAfterBack.routes[stateAfterBack.index!]!.name).toBe(origin);
    const cardStack = stateAfterBack.routes.find((route: any) => route.name === origin)!.state!;
    expect(cardStack.routes[cardStack.index!]!).toMatchObject({ name: 'CardDetail', params: { cardId: 'card-a' } });
    const feedAfterBack = stateAfterBack.routes.find((route: any) => route.name === 'FeedTab')!.state!;
    expect(feedAfterBack.routes.map((route: any) => route.name)).toEqual(['Feed']);
    view.unmount();
  },
);

test('복원된 Feed의 기존 Chat A 위에서 카드 세션 B를 열면 B가 최상단이다', async () => {
  const navigation = createNavigationContainerRef<any>();
  const previousFeed = buildPhoneState({
    originTab: 'FeedTab', kind: 'chat', sessionId: 'session-a', returnTab: 'DailyTab', cardId: 'card-a',
  });
  const initialState = buildPhoneState({ originTab: 'DailyTab', kind: 'cardDetail', cardId: 'card-a' }, previousFeed);
  const view = render(<PersistentSessionProvider><NavigationContainer ref={navigation} initialState={initialState}>
    <TabNavigator />
  </NavigationContainer></PersistentSessionProvider>);
  await waitFor(() => expect(navigation.isReady()).toBe(true));

  fireEvent.press(view.getByTestId('open-card-session'));
  await waitFor(() => expect(navigation.getCurrentRoute()?.name).toBe('Chat'));
  const feed = navigation.getRootState().routes.find((route: any) => route.name === 'FeedTab')!.state!;
  expect(feed.routes[feed.index!]!).toMatchObject({ name: 'Chat', params: { sessionId: 'session-b' } });
  view.unmount();
});

test('Feed 안의 Chat A → 카드 → Chat B에서 뒤로 가면 카드, Chat A, Feed 순서로 돌아온다', async () => {
  const navigation = createNavigationContainerRef<any>();
  const initialState = buildPhoneState({
    originTab: 'FeedTab', kind: 'chat', sessionId: 'session-a', returnTab: 'FeedTab',
  });
  const view = render(<PersistentSessionProvider><NavigationContainer ref={navigation} initialState={initialState}>
    <TabNavigator />
  </NavigationContainer></PersistentSessionProvider>);
  await waitFor(() => expect(navigation.isReady()).toBe(true));
  expect(navigation.getCurrentRoute()).toMatchObject({ name: 'Chat', params: { sessionId: 'session-a' } });

  act(() => navigation.navigate('FeedTab', { screen: 'CardDetail', params: { cardId: 'card-a' } }));
  await waitFor(() => expect(navigation.getCurrentRoute()?.name).toBe('CardDetail'));
  fireEvent.press(view.getByTestId('open-card-session'));
  await waitFor(() => expect(navigation.getCurrentRoute()).toMatchObject({ name: 'Chat', params: { sessionId: 'session-b' } }));
  const feed = navigation.getRootState().routes.find((route: any) => route.name === 'FeedTab')!.state!;
  expect(feed.routes.map((route: any) => route.name)).toEqual(['Feed', 'Chat', 'CardDetail', 'Chat']);

  const backToFeedStack = () => openPreviousPhonePanel({ getParent: () => navigation, goBack: () => navigation.goBack() }, 'FeedTab');
  act(backToFeedStack);
  await waitFor(() => expect(navigation.getCurrentRoute()?.name).toBe('CardDetail'));
  act(() => navigation.goBack());
  await waitFor(() => expect(navigation.getCurrentRoute()).toMatchObject({ name: 'Chat', params: { sessionId: 'session-a' } }));
  act(backToFeedStack);
  await waitFor(() => expect(navigation.getCurrentRoute()?.name).toBe('Feed'));
  view.unmount();
});

test.each(['PersistentSession', 'CardDetail'] as const)('iPad %s 위 알림·URL은 같은 Main으로 pop하고 대상 workspace를 연다', async top => {
  for (const entry of ['notification', 'search'] as const) {
    const navigation = createNavigationContainerRef<any>();
    let host!: ReturnType<typeof usePersistentSessionHost>;
    function Capture() { host = usePersistentSessionHost(); return null; }
    const view = render(<PersistentSessionProvider><Capture /><NavigationContainer ref={navigation}><TabletNavigator /></NavigationContainer></PersistentSessionProvider>);
    await waitFor(() => expect(navigation.isReady()).toBe(true));
    const mainKey = navigation.getRootState().routes[0].key;
    act(() => { host.store.getState().open({ session_id: 'pas' } as any); navigation.navigate('PersistentSession'); });
    if (top === 'CardDetail') act(() => navigation.navigate('CardDetail', { cardId: 'card' }));
    expect(navigation.getRootState().routes.map(route => route.name)).toEqual(top === 'CardDetail' ? ['Main', 'PersistentSession', 'CardDetail'] : ['Main', 'PersistentSession']);
    const leave = jest.fn(() => host.store.getState().leave());
    await act(async () => { await openTabletSessionFromRoot(navigation, leave, 'intent-target', undefined, undefined, entry); });
    expect(leave).toHaveBeenCalledTimes(1);
    expect(host.store.getState().visible).toBe(false);
    expect(navigation.getRootState().routes.map(route => route.name)).toEqual(['Main']);
    expect(navigation.getRootState().routes[0].key).toBe(mainKey);
    expect(navigation.getCurrentRoute()?.name).toBe('Main');
    expect(view.getByTestId('real-main')).toBeTruthy();
    expect(useUIStore.getState()).toMatchObject({ activeSessionId: 'intent-target', folderOverlayVisible: true });
    view.unmount();
  }
});
