jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
jest.mock('@expo/vector-icons/MaterialCommunityIcons', () => 'MaterialCommunityIcons');
const mockOpenContentLink = jest.fn();
const mockApi = {
  listCards: jest.fn().mockResolvedValue({ cards: [] }),
  getCard: jest.fn(),
  setCardStatus: jest.fn(),
  dismissPersistentReport: jest.fn(),
  confirmCardItem: jest.fn(),
  addCardComment: jest.fn(),
  answerCardQuestion: jest.fn(),
};
jest.mock('../../hooks/useOpenContentLink', () => ({ useOpenContentLink: () => mockOpenContentLink }));
jest.mock('../../api/client', () => ({ createApiClient: () => mockApi }));
let mockDevice = 'phone';
let mockKeyboardLayout = false;
jest.mock('../../theme/useDeviceType', () => ({ useDeviceType: () => mockDevice, deviceTypeToBaseKey: (device: string) => device === 'phone' ? 'phone' : 'tablet' }));
jest.mock('../../components/chat/ChatBody', () => {
  const React = require('react'); const { View, TextInput } = require('react-native');
  const { AppKeyboardAvoidingView } = require('../../components/AppKeyboardAvoidingView');
  return { ChatBody: (props: any) => {
    const [draft, setDraft] = React.useState('');
    const latest = React.useRef(props);
    latest.current = props;
    const onOverlapChange = React.useCallback((overlap: number) => {
      // Yoga's padding response at the ChatBody boundary; the inset itself is
      // calculated by the production avoider from the native keyboard event.
      latest.current.onKeyboardOverlapChange?.(overlap);
      if (mockKeyboardLayout) latest.current.onComposerLayout(
        { x: 0, y: 644 - overlap, width: 480, height: 76 },
        { x: 0, y: 20, width: 480, height: 56 });
    }, []);
    React.useEffect(() => {
      if (!props.active || !props.sessionId) return undefined;
      const probe = (globalThis as any).__persistentChatConnectionProbe;
      probe.opens += 1;
      probe.connected = true;
      return () => { probe.closes += 1; probe.connected = false; };
    }, [props.active, props.sessionId]);
    return <View testID="persistent-body-probe" {...props}>
      <AppKeyboardAvoidingView testID="persistent-keyboard-probe" behavior="padding" onOverlapChange={onOverlapChange}>
        {props.reportView}<TextInput key={props.sessionId} testID="persistent-draft" value={draft} onChangeText={setDraft} />
      </AppKeyboardAvoidingView>
    </View>;
  } };
});
jest.mock('../../components/persistent/PersistentSessionTaskList', () => {
  const { Pressable, View } = require('react-native');
  return { PersistentSessionTaskList: ({ onOpenCard, visible = true }: any) => <View testID="persistent-task-list-mock"
    style={{ display: visible ? 'flex' : 'none' }}><Pressable testID="choose-card" onPress={() => onOpenCard('card-1')} /></View> };
});
jest.mock('../../components/persistent/SwayCharacter', () => ({ SwayCharacter: () => null }));
jest.mock('../../components/persistent/PersistentSessionCardOverlay', () => {
  const { Pressable, View } = require('react-native');
  return { PersistentSessionCardOverlay: ({ cardId, sessionId, bottomSafeAreaInset, onClose }: any) => cardId ? <View testID="persistent-card-overlay-mock" cardId={cardId} sessionId={sessionId} bottomSafeAreaInset={bottomSafeAreaInset}>
    <Pressable testID="close-card-overlay" onPress={onClose} />
  </View> : null };
});
jest.mock('../../components/AppModalSurface', () => {
  const { View } = require('react-native');
  return { AppModalSurface: ({ visible, modalId, onRequestClose, onDismiss, children, surfaceTestID }: any) =>
    <View testID={surfaceTestID} visible={visible} modalId={modalId} onRequestClose={onRequestClose} onDismiss={onDismiss}>{children}</View> };
});
jest.mock('../../components/settings/PersistentSessionPasSettingsModal', () => {
  const { View } = require('react-native');
  return { PersistentSessionPasSettingsModal: (props: any) => <View testID="pas-settings-modal" {...props} /> };
});
jest.mock('../SettingsScreen', () => ({ SettingsScreen: () => null }));
jest.mock('../../hooks/useUsageSummary', () => ({ useUsageSummary: jest.fn() }));

import React from 'react';
import { act, fireEvent, render, waitFor, within } from '@testing-library/react-native';
import { PersistentSessionProvider, usePersistentSessionHost } from '../../navigation/PersistentSessionContext';
import { PersistentSessionScreen } from '../PersistentSessionScreen';
import { ChatUiControllerProvider } from '../../components/chat-ui/ChatUiControllerProvider';
import type { PersistentSessionScene } from '../../store/persistentSessionScene';
import type { StoreApi } from 'zustand';
import { Keyboard, Platform, ScrollView, StyleSheet, View } from 'react-native';
import { renderHook } from '@testing-library/react-native';
import { useChatStore } from '../../store/chatStore';
import { useSessionStore } from '../../store/sessionStore';
import { reportReviewEntries } from '../../component-review/persistent-report-fixtures';
import { useAuthStore } from '../../store/authStore';
import { useSettingsStore } from '../../store/settingsStore';
import { useUsageSummary } from '../../hooks/useUsageSummary';
import { useTokens } from '../../theme';
import { AppModalSurface } from '../../components/AppModalSurface';
import { GlassButton } from '../../components/GlassSurface';
import { measurePersistentReports } from '../../test-utils/persistent-report-layout';
import type { CardDetail } from '../../api/cardTypes';
import { cardFixture } from '../../test-support/cards';
import type { PersistentReportEntry } from '../../api/types';
import { DuoSideBandContext } from '../../navigation/tabContract';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';
import { NavigationContainer } from '@react-navigation/native';

let store: StoreApi<PersistentSessionScene>;
function Capture() { store = usePersistentSessionHost().store; return null; }
function ScreenHarness({ active = true, show = true }: { active?: boolean; show?: boolean }) {
  return <PersistentSessionProvider><Capture />{show ? <PersistentSessionScreen active={active} onHome={jest.fn()} /> : null}</PersistentSessionProvider>;
}
beforeEach(() => {
  mockKeyboardLayout = false;
  mockOpenContentLink.mockReset();
  useSettingsStore.setState({ serverUrl: '' });
  const card = cardFixture({ id: 'card-531', number: 531, status: 'review', assigneeSessionId: 'pas-card-phone',
    now: { text: '검수 결과를 확인해 주세요.', turn: 'user', ask: '확인 항목도 살펴봐 주세요.', updatedAt: '2026-10-21T00:00:00Z', sessionId: 'pas-card-phone' } });
  mockApi.getCard.mockReset().mockResolvedValue({ card: { ...card, items: [] }, reports: [], questions: [], sessions: [], nowHistory: [], comments: [] } as CardDetail);
  mockApi.setCardStatus.mockReset().mockImplementation(async (_id: string, status: string, version: number) => ({
    folderId: card.folderId, card: { ...card, status, version: version + 1 },
  }));
  (globalThis as any).__persistentChatConnectionProbe = { opens: 0, closes: 0, connected: false };
  jest.mocked(useUsageSummary).mockReturnValue({ summary: null, node: null, gauges: [], loading: false, loadState: 'idle', evaluatedAtMs: 0, retry: jest.fn() });
});
test('카드를 누르면 바로 오버레이가 열리고 PAS ChatBody와 입력 draft는 그대로 유지된다', () => {
  mockDevice = 'tabletLandscape';
  (globalThis as any).__persistentChatConnectionProbe = { opens: 0, closes: 0, connected: false };
  const view = render(<PersistentSessionProvider><Capture /><PersistentSessionScreen onHome={jest.fn()} /></PersistentSessionProvider>);
  act(() => store.getState().open({ session_id: 'pas-1', display_name: '관제', persistent: true } as any));
  expect((globalThis as any).__persistentChatConnectionProbe).toMatchObject({ opens: 1, closes: 0, connected: true });
  fireEvent.changeText(view.getByTestId('persistent-draft'), '진행 중인 입력');
  fireEvent.press(view.getByTestId('persistent-session-tasks'));
  const body = view.getByTestId('persistent-body-probe', { includeHiddenElements: true });
  expect(body.props.active).toBe(true);
  expect(body.props.sessionId).toBe('pas-1');
  fireEvent.press(view.getByTestId('choose-card'));
  expect(view.getByTestId('persistent-card-overlay-mock').props.cardId).toBe('card-1');
  expect(store.getState().selectedCardId).toBe('card-1');
  expect(view.getByTestId('persistent-card-overlay-mock').props).toEqual(expect.objectContaining({ cardId: 'card-1', sessionId: 'pas-1' }));
  expect(view.getByTestId('persistent-card-overlay-mock').props.bottomSafeAreaInset)
    .toBe(body.props.minimumBottomPadding);
  expect(body.props.active).toBe(true);
  expect((globalThis as any).__persistentChatConnectionProbe).toMatchObject({ opens: 1, closes: 0, connected: true });
  expect(view.queryByTestId('persistent-summary-header')).toBeNull();
  expect(StyleSheet.flatten(view.getByTestId('persistent-task-list-mock', { includeHiddenElements: true }).props.style).display).toBe('none');
  expect(view.getByTestId('persistent-draft', { includeHiddenElements: true }).props.value).toBe('진행 중인 입력');
  fireEvent.press(view.getByTestId('close-card-overlay'));
  expect(store.getState().selectedCardId).toBeNull();
  expect(view.queryByTestId('persistent-card-overlay-mock')).toBeNull();
  expect(StyleSheet.flatten(view.getByTestId('persistent-task-list-mock').props.style).display).toBe('flex');
  act(() => store.getState().swipe('right'));
  expect(view.getByTestId('persistent-body-probe').props.active).toBe(true);
  expect(view.getByTestId('persistent-draft').props.value).toBe('진행 중인 입력');
  expect((globalThis as any).__persistentChatConnectionProbe).toMatchObject({ opens: 1, closes: 0, connected: true });
  view.unmount();
  expect((globalThis as any).__persistentChatConnectionProbe).toMatchObject({ opens: 1, closes: 1, connected: false });
});

test('phone report deck touch leaves page swipes to the deck and conversation swipes to the scene', () => {
  mockDevice = 'phone';
  const measure = jest.spyOn((View as any).prototype, 'measureInWindow').mockImplementation(function(this: any, callback: any) {
    if (this.props.testID === 'persistent-session-screen') callback(0, 47, 390, 715);
    else if (this.props.testID === 'persistent-session-conversation') callback(20, 95, 350, 667);
  });
  const view = render(<PersistentSessionProvider><Capture /><PersistentSessionScreen onHome={jest.fn()} /></PersistentSessionProvider>);
  act(() => {
    store.getState().open({ session_id: 'pas-swipe', display_name: '관제', persistent: true } as any);
    useSessionStore.getState().applyPersistentReport('pas-swipe', reportReviewEntries);
  });
  act(() => view.getByTestId('persistent-session-screen').props.onLayout());
  const body = view.getByTestId('persistent-body-probe');
  act(() => body.props.onComposerLayout(
    { x: 0, y: 560, width: 350, height: 76 },
    { x: 0, y: 20, width: 350, height: 56 },
  ));
  const pager = body.props.reportView as React.ReactElement<{ onDeckTouch?: (active: boolean) => void }> | null;
  expect(pager).toBeTruthy();
  expect(pager?.props.onDeckTouch).toEqual(expect.any(Function));

  const screen = view.getByTestId('persistent-session-screen');
  const touchEvent = (timestamp: number, x: number, previousX: number) => ({
    nativeEvent: { touches: [{ identifier: 0, pageX: x, pageY: 0 }] },
    touchHistory: {
      indexOfSingleActiveTouch: 0,
      mostRecentTimeStamp: timestamp,
      numberActiveTouches: 1,
      touchBank: [{
        touchActive: true,
        currentPageX: x,
        currentPageY: 0,
        currentTimeStamp: timestamp,
        previousPageX: previousX,
        previousPageY: 0,
        previousTimeStamp: timestamp - 1,
        startPageX: previousX,
        startPageY: 0,
        startTimeStamp: 1,
      }],
    },
  });
  const beginSwipe = (timestamp: number) => {
    screen.props.onStartShouldSetResponderCapture(touchEvent(timestamp, 300, 300));
  };
  const moveShouldSet = (timestamp: number) => {
    const event = touchEvent(timestamp, 228, 300);
    screen.props.onMoveShouldSetResponderCapture(event);
    return { event, shouldSet: screen.props.onMoveShouldSetResponder(event) };
  };

  act(() => pager?.props.onDeckTouch?.(true));
  beginSwipe(1);
  expect(moveShouldSet(2).shouldSet).toBe(false);
  act(() => pager?.props.onDeckTouch?.(false));

  beginSwipe(3);
  const conversationSwipe = moveShouldSet(4);
  expect(conversationSwipe.shouldSet).toBe(true);
  screen.props.onResponderGrant(conversationSwipe.event);
  const released = touchEvent(5, 150, 228);
  screen.props.onResponderMove(released);
  act(() => screen.props.onResponderRelease(released));
  expect(store.getState().scene).toBe('cards');

  view.unmount();
  measure.mockRestore();
});

test('card report opens an iPhone page sheet and expands inline on iPad', async () => {
  const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
  const cardReport = { key: 'card_531', kind: 'see' as const, title: '검수 결과', card_numbers: [531], card_id: 'card-531',
    card_status: 'review', context: '결과를 확인해 주세요.', action: '', options: [], state: 'open' as const, answer: '', updated_at: '2026-10-21T00:00:00Z' };
  const measure = jest.spyOn((View as any).prototype, 'measureInWindow').mockImplementation(function(this: any, callback: any) {
    if (this.props.testID === 'persistent-session-screen') callback(0, 47, 390, 715);
    else if (this.props.testID === 'persistent-session-conversation') callback(20, 95, 350, 667);
  });
  mockDevice = 'phone';
  useSettingsStore.setState({ serverUrl: 'https://screen.test' });
  const phone = render(<PersistentSessionProvider><Capture /><PersistentSessionScreen onHome={jest.fn()} /></PersistentSessionProvider>);
  act(() => {
    store.getState().open({ session_id: 'pas-card-phone', display_name: '관제', persistent: true } as any);
    useSessionStore.getState().applyPersistentReport('pas-card-phone', [cardReport]);
  });
  act(() => phone.getByTestId('persistent-session-screen').props.onLayout());
  const phoneBody = phone.getByTestId('persistent-body-probe');
  act(() => phoneBody.props.onComposerLayout({ x: 0, y: 560, width: 350, height: 76 }, { x: 0, y: 20, width: 350, height: 56 }));
  const phonePager = phone;
  measurePersistentReports(phonePager);
  await waitFor(() => expect(phonePager.getByTestId('report-title')).toBeTruthy());
  fireEvent.press(phonePager.getByTestId('report-title'), { stopPropagation: jest.fn() });
  const modal = phone.UNSAFE_getByType(AppModalSurface);
  expect(errors.mock.calls.filter(args => String(args[0]).includes('same key'))).toEqual([]);
  errors.mockRestore();
  expect(modal.props.variant).toBe('expanded');
  expect(modal.props.presentationStyle).toBe('pageSheet');
  expect(phone.getByTestId('persistent-session-report-card-sheet')).toBeTruthy();
  expect(phone.getAllByText('검수 대기')).toHaveLength(2);
  await waitFor(() => expect(phone.getByTestId('persistent-report-card-expansion-card_531')).toBeTruthy());
  const scrollToEnd = jest.spyOn(ScrollView.prototype, 'scrollToEnd').mockImplementation(() => {});
  fireEvent(phone.getByPlaceholderText('커멘트'), 'focus');
  const sheetScroll = phone.UNSAFE_getAllByType(ScrollView).find(scroll => scroll.props.automaticallyAdjustKeyboardInsets);
  expect(sheetScroll).toBeDefined();
  fireEvent.changeText(phone.getByPlaceholderText('커멘트'), '아이폰에서도\n입력이\n여러 줄로\n늘어납니다.');
  fireEvent(sheetScroll!, 'contentSizeChange', 390, 1184);
  await waitFor(() => expect(scrollToEnd).toHaveBeenCalled());
  fireEvent(phone.getByPlaceholderText('커멘트'), 'blur');
  scrollToEnd.mockClear();
  fireEvent(sheetScroll!, 'layout', { nativeEvent: { layout: { height: 400 } } });
  expect(scrollToEnd).not.toHaveBeenCalled();
  scrollToEnd.mockRestore();
  expect(mockOpenContentLink).not.toHaveBeenCalled();
  const closeAfterOpen = phone.UNSAFE_getByType(AppModalSurface).props.onDismiss;
  const openCard = phone.UNSAFE_getAllByType(GlassButton).find(button => button.props.accessibilityLabel === '카드 열기');
  expect(openCard).toBeDefined();
  act(() => openCard!.props.onPress());
  await waitFor(() => expect(phone.UNSAFE_getByType(AppModalSurface).props.visible).toBe(false));
  const closingSheet = phone.UNSAFE_getByType(AppModalSurface);
  expect(mockOpenContentLink).not.toHaveBeenCalled();
  act(() => closingSheet.props.onDismiss());
  expect(mockOpenContentLink).toHaveBeenCalledTimes(1);
  expect(mockOpenContentLink).toHaveBeenCalledWith('/?card=card-531');
  act(() => closeAfterOpen());
  expect(mockOpenContentLink).toHaveBeenCalledTimes(1);

  fireEvent.press(phone.getByTestId('report-title'), { stopPropagation: jest.fn() });
  await waitFor(() => expect(phone.getByTestId('persistent-session-report-card-sheet').props.visible).toBe(true));
  expect(phone.getByLabelText('축소')).toBeTruthy();
  expect(phone.queryByLabelText('닫기')).toBeNull();
  fireEvent.press(phone.getByLabelText('축소'));
  await waitFor(() => expect(phone.getByTestId('persistent-session-report-card-sheet').props.visible).toBe(false));

  fireEvent.press(phone.getByTestId('report-title'), { stopPropagation: jest.fn() });
  await waitFor(() => expect(phone.getByTestId('persistent-session-report-card-sheet').props.visible).toBe(true));
  expect(phone.getByTestId('persistent-report-card-sheet-complete')).toBeTruthy();
  mockApi.setCardStatus.mockClear();
  await act(async () => { fireEvent.press(phone.getByTestId('persistent-report-card-sheet-complete')); });
  await waitFor(() => expect(phone.getByTestId('persistent-session-report-card-sheet').props.visible).toBe(false));
  expect(mockApi.setCardStatus).toHaveBeenCalledTimes(1);
  expect(mockApi.setCardStatus.mock.calls[0][1]).toBe('done');
  phone.unmount();

  mockDevice = 'tabletLandscape';
  const dimensions = jest.spyOn(require('react-native'), 'useWindowDimensions').mockReturnValue({ width: 1180, height: 820, scale: 1, fontScale: 1 });
  const tabletMeasure = jest.spyOn((View as any).prototype, 'measureInWindow').mockImplementation(function(this: any, callback: any) {
    if (this.props.testID === 'persistent-session-screen') callback(0, 24, 1180, 796);
    else if (this.props.testID === 'persistent-session-conversation') callback(350, 100, 480, 720);
  });
  const tablet = render(<PersistentSessionProvider><Capture /><PersistentSessionScreen onHome={jest.fn()} /></PersistentSessionProvider>);
  act(() => {
    store.getState().open({ session_id: 'pas-card-tablet', display_name: '관제', persistent: true } as any);
    useSessionStore.getState().applyPersistentReport('pas-card-tablet', [cardReport]);
  });
  act(() => tablet.getByTestId('persistent-session-screen').props.onLayout());
  const tabletBody = tablet.getByTestId('persistent-body-probe');
  act(() => tabletBody.props.onComposerLayout({ x: 0, y: 560, width: 480, height: 76 }, { x: 0, y: 20, width: 480, height: 56 }));
  const tabletPager = tablet;
  measurePersistentReports(tabletPager);
  await waitFor(() => expect(tabletPager.getByTestId('report-title')).toBeTruthy());
  fireEvent.press(tabletPager.getByTestId('report-title'));
  await waitFor(() => expect(tabletPager.getByTestId('persistent-report-card-expansion-card_531')).toBeTruthy());
  expect(tablet.queryByTestId('persistent-session-report-card-sheet')).toBeNull();
  tablet.unmount();
  tabletMeasure.mockRestore(); dimensions.mockRestore(); measure.mockRestore();
});

test('blocked card sheet does not show the completion action', async () => {
  mockDevice = 'phone';
  useSettingsStore.setState({ serverUrl: 'https://screen.test' });
  const measure = jest.spyOn((View as any).prototype, 'measureInWindow').mockImplementation(function(this: any, callback: any) {
    if (this.props.testID === 'persistent-session-screen') callback(0, 47, 390, 715);
    else if (this.props.testID === 'persistent-session-conversation') callback(20, 95, 350, 667);
  });
  const blockedReport = { key: 'card_blocked', kind: 'see' as const, title: '막힌 카드', card_numbers: [531], card_id: 'card-531',
    card_status: 'blocked', context: '진행할 수 없습니다.', action: '', options: [], state: 'open' as const, answer: '', updated_at: 'now' };
  const view = render(<PersistentSessionProvider><Capture /><PersistentSessionScreen onHome={jest.fn()} /></PersistentSessionProvider>);
  act(() => {
    store.getState().open({ session_id: 'pas-blocked-phone', display_name: '관제', persistent: true } as any);
    useSessionStore.getState().applyPersistentReport('pas-blocked-phone', [blockedReport]);
  });
  act(() => view.getByTestId('persistent-session-screen').props.onLayout());
  act(() => view.getByTestId('persistent-body-probe').props.onComposerLayout(
    { x: 0, y: 560, width: 350, height: 76 }, { x: 0, y: 20, width: 350, height: 56 }));
  measurePersistentReports(view);
  await waitFor(() => expect(view.getByTestId('report-title')).toBeTruthy());
  fireEvent.press(view.getByTestId('report-title'), { stopPropagation: jest.fn() });
  await waitFor(() => expect(view.getByTestId('persistent-session-report-card-sheet').props.visible).toBe(true));
  expect(view.queryByTestId('persistent-report-card-sheet-complete')).toBeNull();
  view.unmount();
  measure.mockRestore();
});

test('iOS keyboard padding moves the expanded bubble inline without replacing its focused TextInput', async () => {
  mockDevice = 'tabletLandscape';
  mockKeyboardLayout = true;
  const dimensions = jest.spyOn(require('react-native'), 'useWindowDimensions').mockReturnValue({ width: 1180, height: 820, scale: 1, fontScale: 1 });
  const listeners = new Map<string, Set<(event: any) => void>>();
  const keyboard = jest.spyOn(Keyboard, 'addListener').mockImplementation((name, callback) => {
    const callbacks = listeners.get(name) ?? new Set(); callbacks.add(callback); listeners.set(name, callbacks);
    return { remove: () => { callbacks.delete(callback); } } as ReturnType<typeof Keyboard.addListener>;
  });
  const measure = jest.spyOn((View as any).prototype, 'measureInWindow').mockImplementation(function(this: any, callback: any) {
    if (this.props.testID === 'persistent-session-screen') callback(0, 24, 1180, 796);
    else if (['persistent-session-conversation', 'persistent-keyboard-probe'].includes(this.props.testID)) callback(350, 100, 480, 720);
  });
  const scrollToEnd = jest.spyOn(ScrollView.prototype, 'scrollToEnd').mockImplementation(() => {});
  useSettingsStore.setState({ serverUrl: 'https://screen.test' });
  const view = render(<ScreenHarness />);
  const sessionId = 'pas-keyboard-card';
  act(() => {
    store.getState().open({ session_id: sessionId, persistent: true } as any);
    useSessionStore.getState().applyPersistentReport(sessionId, [{ key: 'card_keyboard', kind: 'see', title: '검수 결과',
      card_id: 'card-531', card_status: 'review', card_numbers: [531], context: '확인해 주세요.', action: '', options: [], state: 'open', answer: '', updated_at: 'now' }]);
    const request = useChatStore.getState().beginPersistentDisplaySettingsLoad(sessionId);
    useChatStore.getState().finishPersistentDisplaySettingsLoad(sessionId, request, { show_character: true, animate_character: false,
      show_generation_separator: true, show_jev_candidates: true, turn_usage_mode: 'collapsed' });
    view.getByTestId('persistent-session-screen').props.onLayout();
  });
  fireEvent(view.getByTestId('persistent-keyboard-probe'), 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 480, height: 720 } } });
  act(() => view.getByTestId('persistent-body-probe').props.onComposerLayout(
    { x: 0, y: 644, width: 480, height: 76 }, { x: 0, y: 20, width: 480, height: 56 }));
  expect(view.getByTestId('persistent-session-report-bubble-seat', { includeHiddenElements: true })).toBeTruthy();
  measurePersistentReports(view, { width: 318 });
  fireEvent.press(view.getByTestId('report-title'));
  await waitFor(() => expect(view.getByPlaceholderText('커멘트')).toBeTruthy());
  const input = view.getByPlaceholderText('커멘트');
  fireEvent(input, 'focus');
  fireEvent.changeText(input, '키보드가 떠도 유지되는 커멘트');
  act(() => {
    for (const callback of listeners.get(Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow') ?? []) callback({
      duration: 250, easing: 'keyboard', isEventFromThisApp: true,
      endCoordinates: { screenX: 0, screenY: 422, width: 1180, height: 398 },
    });
  });
  expect(StyleSheet.flatten(view.getByTestId('persistent-keyboard-probe').props.style).paddingBottom).toBe(398);
  expect(view.getByTestId('persistent-body-probe').props.reportView).toBeTruthy();
  // A width change also goes through the real pager measurement path.
  measurePersistentReports(view, { width: 480, readingHeight: 1000 });
  const after = view.getByPlaceholderText('커멘트');
  expect(after === input).toBe(true);
  expect(after.props.value).toBe('키보드가 떠도 유지되는 커멘트');
  expect(view.getByTestId('report-title').props.accessibilityState.expanded).toBe(true);
  const deck = StyleSheet.flatten(view.getByTestId('report-deck').props.style);
  expect(deck.maxHeight).toBeLessThan(422 - 100);
  expect(within(view.getByTestId('report-scroll')).getByTestId('card-comment-composer')).toBeTruthy();
  await waitFor(() => expect(scrollToEnd).toHaveBeenCalled());
  view.unmount(); scrollToEnd.mockRestore(); measure.mockRestore(); keyboard.mockRestore(); dimensions.mockRestore();
});

test('열 크기가 같은 x 이동도 다시 실측해 몸 하단과 선 접점을 유지한다', () => {
  mockDevice = 'tabletLandscape';
  const dimensions = jest.spyOn(require('react-native'), 'useWindowDimensions').mockReturnValue({ width: 1180, height: 820, scale: 1, fontScale: 1 });
  let width = 1180;
  const measure = jest.spyOn((View as any).prototype, 'measureInWindow').mockImplementation(function(this: any, callback: any) {
    if (this.props.testID === 'persistent-session-screen') callback(0, 24, width, 796);
    else if (this.props.testID === 'persistent-session-conversation') callback((width - 480) / 2, 100, 480, 720);
  });
  const view = render(<PersistentSessionProvider><Capture /><PersistentSessionScreen onHome={jest.fn()} /></PersistentSessionProvider>);
  act(() => {
    store.getState().open({ session_id: 'pas-1', display_name: '관제', persistent: true } as any);
    const request = useChatStore.getState().beginPersistentDisplaySettingsLoad('pas-1');
    useChatStore.getState().finishPersistentDisplaySettingsLoad('pas-1', request, { show_character: true, animate_character: true, show_generation_separator: true, show_jev_candidates: true, turn_usage_mode: 'collapsed' });
  });
  act(() => view.getByTestId('persistent-session-screen').props.onLayout());
  const body = view.getByTestId('persistent-body-probe');
  expect(body.props.reportView).toBeNull(); // No provisional band before composer/layout measurement.
  act(() => body.props.onComposerLayout(
    { x: 0, y: 644, width: 480, height: 76 },
    { x: 0, y: 20, width: 480, height: 56 },
  ));
  const before = StyleSheet.flatten(view.getByTestId('persistent-session-character-seat').props.style);
  const line = StyleSheet.flatten(view.getByTestId('persistent-session-baseline').props.style);
  act(() => useSessionStore.getState().applyPersistentReport('pas-1', reportReviewEntries));
  const bubble = view.getByTestId('persistent-session-report-bubble-seat', { includeHiddenElements: true });
  const character = view.getByTestId('persistent-session-character-seat');
  // Native pointerEvents=none portrait cannot own the report's hit frame.
  const hostParent = (node: typeof bubble) => {
    let parent = node.parent;
    while (parent && typeof parent.type !== 'string') parent = parent.parent;
    return parent;
  };
  // Compare identity as a boolean: printing a React tree on failure is unbounded.
  expect(hostParent(bubble) === hostParent(character)).toBe(true);
  expect(character.props.pointerEvents).toBe('none');
  expect(body.props.reportView).toBeNull();
  expect(StyleSheet.flatten(bubble.props.style).width).toBe(318);
  expect(before.width).toBe(152);
  expect(line.top).toBe(795);
  expect(before.top + before.height).toBe(line.top + 1);
  const toggle = StyleSheet.flatten(view.getByTestId('persistent-session-character-toggle-seat').props.style);
  expect(toggle.top + 48 / 2).toBeLessThan(line.top);
  expect(view.getByTestId('persistent-session-screen').props.onMoveShouldSetResponder).toBeUndefined();
  width = 0;
  act(() => view.getByTestId('persistent-session-screen').props.onLayout());
  expect(StyleSheet.flatten(view.getByTestId('persistent-session-character-seat').props.style)).toEqual(before);
  expect(StyleSheet.flatten(view.getByTestId('persistent-session-baseline').props.style)).toEqual(line);
  width = 1340;
  act(() => view.getByTestId('persistent-session-screen').props.onLayout());
  const after = StyleSheet.flatten(view.getByTestId('persistent-session-character-seat').props.style);
  expect(after.left).toBeGreaterThan(before.left);
  expect(after.width).toBe(152);
  view.unmount();
  measure.mockRestore();
  dimensions.mockRestore();
});

test('입력 줄과 대기 첨부가 anchor 안에서 늘어나도 캐릭터 기준선은 입력 밑줄에 고정된다', () => {
  mockDevice = 'tabletLandscape';
  const dimensions = jest.spyOn(require('react-native'), 'useWindowDimensions').mockReturnValue({ width: 1180, height: 820, scale: 1, fontScale: 1 });
  const measure = jest.spyOn((View as any).prototype, 'measureInWindow').mockImplementation(function(this: any, callback: any) {
    if (this.props.testID === 'persistent-session-screen') callback(0, 24, 1180, 796);
    else if (this.props.testID === 'persistent-session-conversation') callback(350, 100, 480, 720);
  });
  const view = render(<PersistentSessionProvider><Capture /><PersistentSessionScreen onHome={jest.fn()} /></PersistentSessionProvider>);
  act(() => {
    store.getState().open({ session_id: 'pas-baseline', display_name: '관제', persistent: true } as any);
    const request = useChatStore.getState().beginPersistentDisplaySettingsLoad('pas-baseline');
    useChatStore.getState().finishPersistentDisplaySettingsLoad('pas-baseline', request, {
      show_character: true, animate_character: true, show_generation_separator: true, show_jev_candidates: true, turn_usage_mode: 'collapsed',
    });
  });
  act(() => view.getByTestId('persistent-session-screen').props.onLayout());
  const body = view.getByTestId('persistent-body-probe');
  const reportLayout = (anchorY: number, boxY: number, boxHeight: number) => act(() => body.props.onComposerLayout(
    { x: 0, y: anchorY, width: 480, height: boxY + boxHeight },
    { x: 0, y: boxY, width: 480, height: boxHeight },
  ));

  reportLayout(600, 20, 56);
  const firstLine = StyleSheet.flatten(view.getByTestId('persistent-session-baseline').props.style);
  const firstBody = StyleSheet.flatten(view.getByTestId('persistent-session-character-seat').props.style);
  reportLayout(540, 80, 56);
  const secondLine = StyleSheet.flatten(view.getByTestId('persistent-session-baseline').props.style);
  const secondBody = StyleSheet.flatten(view.getByTestId('persistent-session-character-seat').props.style);

  expect(secondLine.top).toBe(firstLine.top);
  expect(secondBody.top + secondBody.height).toBe(firstBody.top + firstBody.height);
  expect(firstBody.top + firstBody.height).toBe(firstLine.top + 1);
  view.unmount(); measure.mockRestore(); dimensions.mockRestore();
});

test('태블릿 인라인 보고 장은 입력창 레이아웃과 키보드 겹침에 맞춰 안정적으로 제한된다', async () => {
  mockDevice = 'tabletLandscape';
  useSettingsStore.setState({ serverUrl: 'https://screen.test' });
  const dimensions = jest.spyOn(require('react-native'), 'useWindowDimensions').mockReturnValue({ width: 951, height: 669, scale: 1, fontScale: 1 });
  const measure = jest.spyOn((View as any).prototype, 'measureInWindow').mockImplementation(function(this: any, callback: any) {
    if (this.props.testID === 'persistent-session-screen') callback(0, 24, 951, 669);
    else if (this.props.testID === 'persistent-session-conversation') callback(350, 100, 480, 569);
  });
  const view = render(<PersistentSessionProvider><Capture /><PersistentSessionScreen onHome={jest.fn()} /></PersistentSessionProvider>);
  const sessionId = 'pas-inline-card';
  const report: PersistentReportEntry = { key: 'card_531', kind: 'see', title: '검수 결과', card_id: 'card-531',
    card_numbers: [531], context: '확인해 주세요.', action: '', options: [], state: 'open', answer: '', updated_at: 'now' };
  act(() => {
    store.getState().open({ session_id: sessionId, display_name: '관제', persistent: true } as any);
    useSessionStore.getState().applyPersistentReport(sessionId, [report]);
    const request = useChatStore.getState().beginPersistentDisplaySettingsLoad(sessionId);
    useChatStore.getState().finishPersistentDisplaySettingsLoad(sessionId, request, {
      show_character: true, animate_character: false, show_generation_separator: true, show_jev_candidates: true, turn_usage_mode: 'collapsed',
    });
    view.getByTestId('persistent-session-screen').props.onLayout();
  });
  const body = view.getByTestId('persistent-body-probe');
  const reportLayout = (anchorY: number) => act(() => body.props.onComposerLayout(
    { x: 0, y: anchorY, width: 480, height: 76 }, { x: 0, y: 20, width: 480, height: 56 },
  ));
  reportLayout(450);
  expect(view.queryByTestId('persistent-session-report-bubble-seat', { includeHiddenElements: true })).toBeNull();
  expect(view.getByTestId('persistent-session-report-inline-seat', { includeHiddenElements: true })).toBeTruthy();
  expect(view.getByTestId('persistent-session-character-seat')).toBeTruthy();
  measurePersistentReports(view, { width: 480, readingHeight: 100 });
  fireEvent.press(view.getAllByTestId('report-title')[0]);
  await waitFor(() => expect(view.getByTestId('persistent-report-card-expansion-card_531')).toBeTruthy());

  const beforeLine = StyleSheet.flatten(view.getByTestId('persistent-session-baseline').props.style).top;
  const beforeCharacter = StyleSheet.flatten(view.getByTestId('persistent-session-character-seat').props.style).top;
  const beforeDeck = StyleSheet.flatten(view.getByTestId('report-deck').props.style).maxHeight;
  const bandMargin = renderHook(() => useTokens()).result.current.uiSpacing.sm;
  expect(beforeDeck + bandMargin * 2).toBe(569 - 76);

  reportLayout(480);
  expect(StyleSheet.flatten(view.getByTestId('report-deck').props.style).maxHeight).toBe(beforeDeck);
  expect(StyleSheet.flatten(view.getByTestId('persistent-session-baseline').props.style).top).toBe(beforeLine);
  expect(StyleSheet.flatten(view.getByTestId('persistent-session-character-seat').props.style).top).toBe(beforeCharacter);

  act(() => body.props.onKeyboardOverlapChange(110));
  expect(StyleSheet.flatten(view.getByTestId('report-deck').props.style).maxHeight).toBe(beforeDeck - 110);
  expect(StyleSheet.flatten(view.getByTestId('persistent-session-baseline').props.style).top).toBe(beforeLine - 110);
  view.unmount(); measure.mockRestore(); dimensions.mockRestore();
});

test.each([
  [true, 'account-off-outline', '캐릭터 숨기기'],
  [false, 'account-outline', '캐릭터 표시'],
] as const)('캐릭터 %s 상태는 동작을 나타내는 사람 아이콘과 이름을 쓴다', (shown, icon, label) => {
  mockDevice = 'tabletLandscape';
  const dimensions = jest.spyOn(require('react-native'), 'useWindowDimensions').mockReturnValue({ width: 1180, height: 820, scale: 1, fontScale: 1 });
  const measure = jest.spyOn((View as any).prototype, 'measureInWindow').mockImplementation(function(this: any, callback: any) {
    if (this.props.testID === 'persistent-session-screen') callback(0, 24, 1180, 796);
    else if (this.props.testID === 'persistent-session-conversation') callback(350, 100, 480, 720);
  });
  const view = render(<PersistentSessionProvider><Capture /><PersistentSessionScreen onHome={jest.fn()} /></PersistentSessionProvider>);
  act(() => {
    store.getState().open({ session_id: `pas-toggle-${shown}`, display_name: '관제', persistent: true } as any);
    const sessionId = `pas-toggle-${shown}`;
    const request = useChatStore.getState().beginPersistentDisplaySettingsLoad(sessionId);
    useChatStore.getState().finishPersistentDisplaySettingsLoad(sessionId, request, {
      show_character: shown, animate_character: true, show_generation_separator: true, show_jev_candidates: true, turn_usage_mode: 'collapsed',
    });
  });
  act(() => view.getByTestId('persistent-session-screen').props.onLayout());
  act(() => view.getByTestId('persistent-body-probe').props.onComposerLayout(
    { x: 0, y: 600, width: 480, height: 76 },
    { x: 0, y: 20, width: 480, height: 56 },
  ));

  expect(view.getByTestId('persistent-session-character-toggle-icon').props.name).toBe(icon);
  expect(view.getByLabelText(label)).toBeTruthy();
  expect(view.getByTestId('persistent-session-character-toggle').props.accessibilityState?.selected).toBeUndefined();
  view.unmount(); measure.mockRestore(); dimensions.mockRestore();
});

test('phone의 원고형 열은 공통 pageInset으로 본문과 입력의 가장자리를 지킨다', () => {
  mockDevice = 'phone';
  const measure = jest.spyOn((View as any).prototype, 'measureInWindow').mockImplementation(function(this: any, callback: any) {
    if (this.props.testID === 'persistent-session-screen') callback(0, 47, 390, 715);
  });
  const view = render(<PersistentSessionProvider><PersistentSessionScreen onHome={jest.fn()} /></PersistentSessionProvider>);
  act(() => view.getByTestId('persistent-session-screen').props.onLayout());
  const column = StyleSheet.flatten(view.getByTestId('persistent-session-conversation').props.style);
  expect(column.left).toBe(20);
  expect(column.width).toBe(350);
  expect(view.queryByTestId('persistent-session-character-seat')).toBeNull();
  view.unmount();
  measure.mockRestore();
});

test.each([
  ['tabletLandscape', 1194, 834, 'landscape'],
  ['tabletPortrait', 834, 1194, 'portrait'],
] as const)('%s는 사용량을 입력선에 맞추고 카드 목록과 간격을 둔다', (device, width, height, orientation) => {
  mockDevice = device;
  const frame = require('../../components/persistent/persistentSessionFrame').PERSISTENT_SESSION_FRAME;
  const tokenHook = renderHook(() => useTokens());
  const dimensions = jest.spyOn(require('react-native'), 'useWindowDimensions').mockReturnValue({ width, height, scale: 1, fontScale: 1 });
  const appTop = 24;
  const appHeight = height - appTop;
  const columns = frame[orientation];
  const measure = jest.spyOn((View as any).prototype, 'measureInWindow').mockImplementation(function(this: any, callback: any) {
    if (this.props.testID === 'persistent-session-screen') callback(0, appTop, width, appHeight);
    else if (this.props.testID === 'persistent-session-conversation') callback((width - columns.conversation) / 2, appTop + frame.header, columns.conversation, appHeight - frame.header);
  });
  const payload = Buffer.from(JSON.stringify({ email: 'usage@example.com', sub: 'usage@example.com', name: '사용자', exp: 2_000_000_000 })).toString('base64url');
  useAuthStore.setState({ jwt: `header.${payload}.signature` });
  useSettingsStore.setState({ serverUrl: 'https://usage.example', persistentSessionDevicePrefs: {} } as never);
  jest.mocked(useUsageSummary).mockReturnValue({
    summary: { nodes: [{ nodeId: 'node-a' }, { nodeId: 'node-b' }, { nodeId: 'node-c' }] } as any,
    node: { nodeId: 'node-a', fetchedAt: '2026-10-13T08:00:00Z' } as any,
    gauges: [
      { id: 'claude', label: 'Claude', remainingPercent: 73, resetAt: 1_900_000_000 },
      { id: 'fable', label: 'Fable', remainingPercent: 41, resetAt: 1_900_000_000 },
      { id: 'codex', label: 'Codex', remainingPercent: 28, resetAt: 1_900_000_000 },
    ],
    loading: false, loadState: 'ready', evaluatedAtMs: 1_800_000_000_000, retry: jest.fn(),
  });
  const view = render(<ScreenHarness />);
  act(() => store.getState().open({ session_id: 'pas-usage', node_id: 'node-a', agent_name: '서소영 (PAS)', display_name: '관제', persistent: true } as any));
  const toggle = view.getByTestId('persistent-session-weekly-usage-toggle');
  expect(toggle.props.accessibilityState?.selected).toBe(false);
  expect(jest.mocked(useUsageSummary).mock.calls.at(-1)?.[0]).toMatchObject({ enabled: false, nodeId: 'node-a', selectedNodeId: null });
  fireEvent.press(toggle);
  expect(useSettingsStore.getState().getPersistentSessionDevicePreference('https://usage.example', 'usage@example.com').showWeeklyUsage).toBe(true);
  expect(jest.mocked(useUsageSummary).mock.calls.at(-1)?.[0]).toMatchObject({ enabled: true, nodeId: 'node-a', selectedNodeId: null });
  act(() => view.getByTestId('persistent-session-screen').props.onLayout());
  const body = view.getByTestId('persistent-body-probe');
  const anchorHeight = 80;
  const anchorY = appHeight - frame.header - anchorHeight;
  act(() => body.props.onComposerLayout(
    { x: 0, y: anchorY, width: columns.conversation, height: anchorHeight },
    { x: 0, y: 24, width: columns.conversation, height: 56 },
  ));
  const lineY = frame.header + anchorY + 24 + 56 - 1;
  const usageSeat = view.getByTestId('persistent-session-weekly-usage-seat');
  const usageStyle = StyleSheet.flatten(usageSeat.props.style);
  expect(usageStyle.position).toBe('absolute');
  expect(usageStyle.right).toBe(20);
  expect(usageStyle.width).toBe(columns.tasks - 2 * tokenHook.result.current.uiSpacing.sm);
  expect(usageStyle.bottom).toBe(appHeight - lineY);
  expect(StyleSheet.flatten(view.getByTestId('persistent-session-conversation').props.style).top).toBe(frame.header);
  expect(view.getByText('소울스트림')).toBeTruthy();
  expect(view.getByText('서소영 (PAS)')).toBeTruthy();
  act(() => usageSeat.props.onLayout({ nativeEvent: { layout: { height: 138 } } }));
  fireEvent.press(view.getByTestId('persistent-session-tasks'));
  const panel = StyleSheet.flatten(view.getByTestId('persistent-session-card-panel').props.style);
  expect(panel.top).toBe(frame.header + 48);
  expect(panel.maxHeight).toBe(Math.max(0, lineY - 138 - 32 - panel.top));
  expect(panel.maxHeight).toBeLessThan(lineY - panel.top);
  fireEvent.press(view.getByLabelText('노드 바꾸기, 현재 node-a'));
  expect(useSettingsStore.getState().getPersistentSessionDevicePreference('https://usage.example', 'usage@example.com').weeklyUsageNodeSelection)
    .toEqual({ configuredNodeId: 'node-a', selectedNodeId: 'node-b' });
  expect(jest.mocked(useUsageSummary).mock.calls.at(-1)?.[0]).toMatchObject({ enabled: true, nodeId: 'node-a', selectedNodeId: 'node-b' });
  fireEvent.press(view.getByTestId('persistent-session-weekly-usage-toggle'));
  expect(useSettingsStore.getState().getPersistentSessionDevicePreference('https://usage.example', 'usage@example.com').weeklyUsageNodeSelection)
    .toEqual({ configuredNodeId: 'node-a', selectedNodeId: 'node-b' });
  expect(view.queryByTestId('persistent-session-weekly-usage-seat')).toBeNull();
  view.unmount();
  tokenHook.unmount();
  measure.mockRestore();
  dimensions.mockRestore();
  useSettingsStore.setState({ serverUrl: '', persistentSessionDevicePrefs: {} } as never);
  useAuthStore.setState({ jwt: null });
});

test('phone hides saved weekly usage and passes a disabled request gate', () => {
  mockDevice = 'phone';
  const payload = Buffer.from(JSON.stringify({ email: 'usage@example.com', sub: 'usage@example.com', name: '사용자', exp: 2_000_000_000 })).toString('base64url');
  useAuthStore.setState({ jwt: `header.${payload}.signature` });
  useSettingsStore.setState({ serverUrl: 'https://usage.example', persistentSessionDevicePrefs: {} } as never);
  useSettingsStore.getState().setPersistentSessionShowWeeklyUsage('https://usage.example', 'usage@example.com', true);
  useSettingsStore.getState().setPersistentSessionWeeklyUsageNodeSelection('https://usage.example', 'usage@example.com',
    { configuredNodeId: 'node-a', selectedNodeId: 'node-b' });
  const view = render(<ScreenHarness />);
  act(() => store.getState().open({ session_id: 'pas-usage', node_id: 'node-a', agent_name: '서소영 (PAS)', display_name: '관제', persistent: true } as any));
  expect(view.queryByTestId('persistent-session-weekly-usage-toggle')).toBeNull();
  expect(view.queryByTestId('persistent-session-weekly-usage-seat')).toBeNull();
  expect(view.queryByTestId('persistent-session-weekly-usage')).toBeNull();
  expect(jest.mocked(useUsageSummary).mock.calls.at(-1)?.[0]).toMatchObject({ enabled: false, nodeId: 'node-a', selectedNodeId: 'node-b' });
  expect(useSettingsStore.getState().getPersistentSessionDevicePreference('https://usage.example', 'usage@example.com').showWeeklyUsage).toBe(true);
  expect(useSettingsStore.getState().getPersistentSessionDevicePreference('https://usage.example', 'usage@example.com').weeklyUsageNodeSelection)
    .toEqual({ configuredNodeId: 'node-a', selectedNodeId: 'node-b' });
  expect(view.getByText('서소영 (PAS)')).toBeTruthy();
  expect(view.queryByText('소울스트림')).toBeNull();
  view.unmount();
  useSettingsStore.setState({ serverUrl: '', persistentSessionDevicePrefs: {} } as never);
  useAuthStore.setState({ jwt: null });
});

test('듀오 태블릿은 머리줄 대신 띠 캡슐과 사용량 열을 쓰고 설정 상태를 공유한다', () => {
  mockDevice = 'tabletLandscape';
  const payload = Buffer.from(JSON.stringify({ email: 'usage@example.com', sub: 'usage@example.com', name: '사용자', exp: 2_000_000_000 })).toString('base64url');
  useAuthStore.setState({ jwt: `header.${payload}.signature` });
  const measure = jest.spyOn((View as any).prototype, 'measureInWindow').mockImplementation(function(this: any, callback: any) {
    if (this.props.testID === 'persistent-session-screen') callback(0, 24, 867, 645);
    else if (this.props.testID === 'persistent-session-conversation') callback(180, 24, 400, 645);
  });
  useSettingsStore.setState({ serverUrl: 'https://usage.example', persistentSessionDevicePrefs: {} } as never);
  const view = render(<SafeAreaInsetsContext.Provider value={{ top: 24, bottom: 24, left: 0, right: 84 }}>
    <DuoSideBandContext.Provider value={true}><NavigationContainer><ScreenHarness /></NavigationContainer></DuoSideBandContext.Provider>
  </SafeAreaInsetsContext.Provider>);
  act(() => store.getState().open({ session_id: 'pas-duo', node_id: 'node-a', agent_name: '서소영', persistent: true } as any));
  act(() => view.getByTestId('persistent-session-screen').props.onLayout());
  expect(view.queryByTestId('persistent-session-header')).toBeNull();
  expect(view.getByLabelText('카드 목록 보기')).toBeTruthy();
  expect(view.getByLabelText('주간 사용량')).toBeTruthy();
  expect(view.getByLabelText('PAS 메뉴')).toBeTruthy();
  fireEvent.press(view.getByLabelText('카드 목록 보기'));
  expect(StyleSheet.flatten(view.getByTestId('persistent-session-conversation').props.style).width).toBe(400);
  expect(StyleSheet.flatten(view.getByTestId('persistent-session-card-panel').props.style).top).toBe(0);
  fireEvent.press(view.getByLabelText('PAS 대화로 돌아가기'));
  fireEvent.press(view.getByLabelText('주간 사용량'));
  expect(StyleSheet.flatten(view.getByTestId('persistent-session-conversation').props.style).width).toBe(400);
  expect(view.getByTestId('persistent-session-usage-column')).toBeTruthy();
  act(() => view.getByTestId('persistent-body-probe').props.onKeyboardOverlapChange(260));
  expect(StyleSheet.flatten(view.getByTestId('persistent-session-duo-band').props.style).bottom).toBe(260);
  expect(StyleSheet.flatten(view.getByTestId('persistent-session-usage-column').props.style).bottom).toBe(260);
  fireEvent.press(view.getByLabelText('카드 목록 보기'));
  expect(view.getByTestId('persistent-session-card-panel')).toBeTruthy();
  act(() => store.getState().setSettingsOpen(true));
  expect(store.getState().settingsOpen).toBe(true);
  expect(view.getByTestId('pas-settings-modal')).toBeTruthy();
  act(() => view.getByTestId('pas-settings-modal').props.onClose());
  expect(store.getState().settingsOpen).toBe(false);
  view.unmount();
  measure.mockRestore();
  useSettingsStore.setState({ serverUrl: '', persistentSessionDevicePrefs: {} } as never);
  useAuthStore.setState({ jwt: null });
});

test('PAS 헤더 액션은 테두리와 바탕 없는 원형 버튼 표면을 쓴다', () => {
  mockDevice = 'phone';
  const view = render(<PersistentSessionProvider><PersistentSessionScreen onHome={jest.fn()} /></PersistentSessionProvider>);
  for (const testID of [
    'persistent-session-appearance-visual',
    'persistent-session-settings-visual',
    'persistent-session-tasks-visual',
  ]) {
    const style = StyleSheet.flatten(view.getByTestId(testID).props.style);
    expect(style.backgroundColor).toBe('transparent');
    expect(style.borderWidth).toBeUndefined();
    expect(style.borderColor).toBeUndefined();
    expect(style.borderRadius).toBeGreaterThan(0);
  }
  view.unmount();

  mockDevice = 'tabletLandscape';
  const tabletView = render(<PersistentSessionProvider><PersistentSessionScreen onHome={jest.fn()} /></PersistentSessionProvider>);
  for (const testID of [
    'persistent-session-home-visual',
    'persistent-session-appearance-visual',
    'persistent-session-settings-visual',
  ]) {
    const style = StyleSheet.flatten(tabletView.getByTestId(testID).props.style);
    expect(style.backgroundColor).toBe('transparent');
    expect(style.borderWidth).toBeUndefined();
    expect(style.borderColor).toBeUndefined();
    expect(style.borderRadius).toBeGreaterThan(0);
  }
  tabletView.unmount();
});

test.each([
  ['phone', false],
  ['tabletLandscape', true],
  ['tabletPortrait', true],
] as const)('%s PAS 대화는 에이전트 이름과 하단 탐색에 맞는 Home만 표시한다', (device, showsHome) => {
  mockDevice = device;
  const onHome = jest.fn();
  const view = render(<PersistentSessionProvider><Capture /><PersistentSessionScreen onHome={onHome} /></PersistentSessionProvider>);
  act(() => store.getState().open({ session_id: 'pas-minimal', display_name: '세션 제목', agent_name: '로젤린', persistent: true } as any));

  const header = view.getByTestId('persistent-session-header');
  expect(view.getByText('로젤린')).toBeTruthy();
  expect(header).toBeTruthy();
  if (showsHome) {
    const home = view.getByLabelText('홈으로 돌아가기');
    expect(home.props.testID).toBe('persistent-session-home');
    fireEvent.press(home);
    expect(onHome).toHaveBeenCalledTimes(1);
  } else {
    expect(view.queryByTestId('persistent-session-home')).toBeNull();
  }
  expect(view.getByTestId('persistent-body-probe').props.showSessionAuxiliary).toBe(false);
  expect(view.queryByText('세션 제목')).toBeNull();
  view.unmount();
});

test('phone 카드 목록은 제목과 같은 가장자리·종이 바탕을 유지하고 메인 카드 상세로 연다', () => {
  mockDevice = 'phone';
  const onOpenPhoneCard = jest.fn();
  const view = render(<PersistentSessionProvider><Capture /><PersistentSessionScreen onHome={jest.fn()} onOpenPhoneCard={onOpenPhoneCard} /></PersistentSessionProvider>);
  act(() => { store.getState().open({ session_id: 'pas-1' } as any); store.getState().toggleScene(); });
  const panel = StyleSheet.flatten(view.getByTestId('persistent-session-card-panel').props.style);
  const paper = StyleSheet.flatten(view.getByTestId('persistent-session-safe-area').props.style);
  expect(panel.paddingHorizontal).toBe(20);
  expect(panel.paddingTop).toBeGreaterThan(0);
  expect(panel.backgroundColor).toBe(paper.backgroundColor);
  fireEvent.press(view.getByTestId('choose-card'));
  expect(StyleSheet.flatten(view.getByTestId('persistent-session-card-panel').props.style)).toEqual(panel);
  expect(onOpenPhoneCard).toHaveBeenCalledWith('card-1');
  expect(store.getState().selectedCardId).toBeNull();
  view.unmount();
});

test.each([[1180, 820], [1194, 834], [820, 1180], [834, 1194]])('iPad %s×%s 목록 패널은 카드 오버레이 전후 같은 위치에 남는다', (width, height) => {
  mockDevice = height > width ? 'tabletPortrait' : 'tabletLandscape';
  const dimensions = jest.spyOn(require('react-native'), 'useWindowDimensions').mockReturnValue({ width, height, scale: 1, fontScale: 1 });
  const measure = jest.spyOn((View as any).prototype, 'measureInWindow').mockImplementation(function(this: any, callback: any) {
    if (this.props.testID === 'persistent-session-screen') callback(0, 24, width, height - 24);
  });
  const view = render(<PersistentSessionProvider><Capture /><PersistentSessionScreen onHome={jest.fn()} /></PersistentSessionProvider>);
  act(() => { view.getByTestId('persistent-session-screen').props.onLayout(); store.getState().open({ session_id: 'pas-1' } as any); store.getState().toggleScene(); });
  const list = StyleSheet.flatten(view.getByTestId('persistent-session-card-panel').props.style);
  expect(width - list.right - list.paddingHorizontal).toBe(width - 20);
  fireEvent.press(view.getByTestId('choose-card'));
  expect(StyleSheet.flatten(view.getByTestId('persistent-session-card-panel').props.style)).toEqual(list);
  expect(view.getByTestId('persistent-card-overlay-mock').props.cardId).toBe('card-1');
  fireEvent.press(view.getByTestId('close-card-overlay'));
  expect(StyleSheet.flatten(view.getByTestId('persistent-session-card-panel').props.style).right).toBe(list.right);
  view.unmount(); measure.mockRestore(); dimensions.mockRestore();
});

test('카드 오버레이가 열리면 작업 목록을 숨기고 닫으면 다시 보인다', () => {
  mockDevice = 'tabletLandscape';
  const view = render(<PersistentSessionProvider><Capture /><PersistentSessionScreen onHome={jest.fn()} /></PersistentSessionProvider>);
  act(() => { store.getState().open({ session_id: 'pas-1' } as any); store.getState().toggleScene(); });
  fireEvent.press(view.getByTestId('choose-card'));

  expect(StyleSheet.flatten(view.getByTestId('persistent-task-list-mock', { includeHiddenElements: true }).props.style).display).toBe('none');
  expect(view.getByTestId('persistent-card-overlay-mock')).toBeTruthy();
  fireEvent.press(view.getByTestId('close-card-overlay'));
  expect(StyleSheet.flatten(view.getByTestId('persistent-task-list-mock').props.style).display).toBe('flex');
  view.unmount();
});
