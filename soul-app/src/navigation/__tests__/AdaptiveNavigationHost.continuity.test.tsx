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
jest.mock('../../components/planner/CardDetailSheet', () => ({ CardDetailContent: () => null }));
jest.mock('../../components/split/SplitLayout', () => ({ SplitLayout: () => require('react').createElement(require('react-native').View, { testID: 'real-main' }) }));
jest.mock('../../screens/PersistentSessionScreen', () => ({ PersistentSessionScreen: () => null }));


import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { createNavigationContainerRef } from '@react-navigation/native';
import { AdaptiveNavigationHost } from '../AdaptiveNavigationHost';
import { LayoutContinuityProvider, useLayoutContinuity } from '../LayoutContinuityContext';
import { PersistentSessionProvider, usePersistentSessionHost } from '../PersistentSessionContext';
import { useUIStore } from '../../store/uiStore';
import { useSearchStore } from '../../store/searchStore';
import { useDraftStore } from '../../store/draftStore';
import { usePersistentDraft } from '../../hooks/usePersistentDraft';
import { useContinuityScroll } from '../../hooks/useContinuityScroll';
import { useChatBottomFollow } from '../../components/chat/useChatBottomFollow';
import { View, Text, Pressable } from 'react-native';

test.each(['Chat', 'CardDetail', 'FolderWorkspace', 'MarkdownDocument', 'Settings', 'PersistentSession'] as const)(
  '%s survives phone → tablet portrait → landscape → phone', async target => {
    const navigation = createNavigationContainerRef<any>();
    let continuity!: ReturnType<typeof useLayoutContinuity>;
    let host!: ReturnType<typeof usePersistentSessionHost>;
    function Capture() { continuity = useLayoutContinuity(); host = usePersistentSessionHost(); return null; }
    const shell = (device: 'phone' | 'tabletPortrait' | 'tabletLandscape') =>
      <PersistentSessionProvider><LayoutContinuityProvider><Capture />
        <AdaptiveNavigationHost device={device} containerRef={navigation} />
      </LayoutContinuityProvider></PersistentSessionProvider>;
    useUIStore.getState().closeFolderOverlay();
    useUIStore.getState().closeSettings();
    useSearchStore.getState().closeTabletSearch();
    const view = render(shell('phone'));
    await waitFor(() => expect(navigation.isReady()).toBe(true));
    act(() => {
      if (target === 'Chat') navigation.navigate('FeedTab', { screen: 'Chat', params: { sessionId: 'session-a', returnTab: 'FeedTab' } });
      if (target === 'CardDetail') navigation.navigate('DailyTab', { screen: target, params: { cardId: 'card-a' } });
      if (target === 'FolderWorkspace') navigation.navigate('FolderTab', { screen: target, params: { folderPageId: 'page-a', folderTitle: '폴더', folderId: 'folder-a' } });
      if (target === 'MarkdownDocument') navigation.navigate('DailyTab', { screen: target, params: { documentId: 'doc-a' } });
      if (target === 'Settings') {
        continuity.setViewState(JSON.stringify(['settings','workspace']), { category: 'recurring-jobs', jobs: { kind: 'history', jobId: 'job-a' }, persistent: { kind: 'list' } });
        navigation.navigate('SettingsTab');
      }
      if (target === 'PersistentSession') {
        host.store.getState().open({ session_id: 'pas-a' } as any);
        host.store.getState().selectCard('pas-card');
        navigation.navigate('PersistentTab', { screen: 'CardDetail', params: { cardId: 'pas-card' } });
      }
    });
    view.rerender(shell('tabletPortrait'));
    await waitFor(() => expect(navigation.getRootState().routes[0].name).toBe('Main'));
    const tabletKey = navigation.getRootState().key;
    if (target === 'Chat') expect(useUIStore.getState()).toMatchObject({ activeSessionId: 'session-a', folderOverlayVisible: true });
    if (target === 'CardDetail') expect(useUIStore.getState().selectedCardId).toBe('card-a');
    if (target === 'FolderWorkspace') expect(useUIStore.getState().selectedFolderPageId).toBe('page-a');
    if (target === 'Settings') expect(useUIStore.getState().settingsVisible).toBe(true);
    view.rerender(shell('tabletLandscape'));
    expect(navigation.getRootState().key).toBe(tabletKey);
    view.rerender(shell('phone'));
    await waitFor(() => expect(navigation.getCurrentRoute()?.name).toBe(target === 'PersistentSession' ? 'CardDetail' : target));
    if (target === 'PersistentSession') expect(navigation.getCurrentRoute()?.params).toMatchObject({ cardId: 'pas-card' });
    if (target === 'Settings') expect(continuity.getViewState<any>(JSON.stringify(['settings','workspace'])).jobs.jobId).toBe('job-a');
    view.unmount();
  });

test('tablet overlay closure and a newer selection win over the old phone snapshot', async () => {
  const navigation = createNavigationContainerRef<any>();
  const shell = (device: 'phone' | 'tabletPortrait') => <PersistentSessionProvider><LayoutContinuityProvider>
    <AdaptiveNavigationHost device={device} containerRef={navigation} />
  </LayoutContinuityProvider></PersistentSessionProvider>;
  const view = render(shell('phone'));
  await waitFor(() => expect(navigation.isReady()).toBe(true));
  act(() => { navigation.navigate('FeedTab', { screen: 'Chat', params: { sessionId: 'old' } }); });
  view.rerender(shell('tabletPortrait'));
  await waitFor(() => expect(navigation.getCurrentRoute()?.name).toBe('Main'));
  act(() => useUIStore.getState().openSessionOverlay('new'));
  view.rerender(shell('phone'));
  await waitFor(() => expect(navigation.getCurrentRoute()?.params).toMatchObject({ sessionId: 'new' }));
  view.rerender(shell('tabletPortrait'));
  await waitFor(() => expect(navigation.getCurrentRoute()?.name).toBe('Main'));
  act(() => useUIStore.getState().closeFolderOverlay());
  view.rerender(shell('phone'));
  await waitFor(() => expect(navigation.getCurrentRoute()?.name).toBe('Feed'));
  view.unmount();
});

test('unidentified draft and a reading scroll offset survive a composer remount', () => {
  (useDraftStore.persist as any).hasHydrated = () => true;
  let memory!: ReturnType<typeof useLayoutContinuity>;
  const list = { current: { scrollToOffset: jest.fn(), recordInteraction: jest.fn() } } as any;
  let follow!: ReturnType<typeof useChatBottomFollow>;
  function Composer() {
    const draft = usePersistentDraft('chat', ['session-a'], '');
    follow = useChatBottomFollow({ flatListRef: list, sessionId: 'session-a', bottomItemKey: 'last' });
    return <View><Text testID="draft">{draft.value}</Text><Pressable testID="edit" onPress={() => draft.setValue('작성 중')} /></View>;
  }
  function Capture() { memory = useLayoutContinuity(); return null; }
  const shell = (shown: boolean) => <LayoutContinuityProvider><Capture />{shown ? <Composer /> : null}</LayoutContinuityProvider>;
  const view = render(shell(true));
  fireEvent.press(view.getByTestId('edit'));
  act(() => { follow.onScrollBeginDrag(); follow.onScrollOffsetChange(330); });
  expect(memory.readScroll(JSON.stringify(['chat','session-a']))).toEqual({ offsetY: 330, followBottom: false });
  view.rerender(shell(false));
  list.current.scrollToOffset.mockClear();
  view.rerender(shell(true));
  expect(view.getByTestId('draft').props.children).toBe('작성 중');
  act(() => follow.onContentSizeChange(2000));
  expect(list.current.scrollToOffset).toHaveBeenCalledWith({ offset: 330, animated: false });
});

test('measured scroll owner waits for real content, clamps, and honors a new drag', () => {
  let memory!: ReturnType<typeof useLayoutContinuity>;
  let scroll!: ReturnType<typeof useContinuityScroll>;
  const scrollTo = jest.fn();
  function Capture() { memory = useLayoutContinuity(); return null; }
  function Probe({ ready }: { ready: boolean }) { scroll = useContinuityScroll('card', scrollTo, ready); return null; }
  const shell = (shown: boolean, ready = true) => <LayoutContinuityProvider><Capture />{shown ? <Probe ready={ready} /> : null}</LayoutContinuityProvider>;
  const view = render(shell(false));
  memory.writeScroll('card', { offsetY: 500 });
  view.rerender(shell(true, false));
  act(() => {
    scroll.onLayout({ nativeEvent: { layout: { height: 300 } } } as any);
    scroll.onContentSizeChange(500, 20);
    scroll.onScroll({ nativeEvent: { contentOffset: { y: 0 } } } as any);
  });
  expect(memory.readScroll('card')?.offsetY).toBe(500);
  act(() => { scroll.onContentSizeChange(500, 700); });
  view.rerender(shell(true));
  expect(scrollTo).toHaveBeenCalledWith(400);
  view.rerender(shell(false));
  view.rerender(shell(true));
  act(() => {
    scroll.onScrollBeginDrag();
    scroll.onScroll({ nativeEvent: { contentOffset: { y: 125 } } } as any);
  });
  expect(memory.readScroll('card')?.offsetY).toBe(125);
});
