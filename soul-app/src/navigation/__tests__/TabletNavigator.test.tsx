jest.mock('@react-navigation/native-stack', () => ({ createNativeStackNavigator: require('./navigationCaptureMock').createNativeStackNavigatorCapture }));
const mockFocusState = { current: true };
jest.mock('@react-navigation/native', () => ({ useIsFocused: () => mockFocusState.current }));
jest.mock('../../components/split/SplitLayout', () => ({ SplitLayout: () => null }));
jest.mock('../../screens/PersistentSessionScreen', () => ({ PersistentSessionScreen: jest.fn(() => null) }));
jest.mock('../../components/planner/CardDetailSheet', () => ({ CardDetailContent: jest.fn(() => null) }));
jest.mock('../../components/planner/MarkdownDocumentContent', () => ({ MarkdownDocumentContent: () => null }));
jest.mock('../../screens/SettingsScreen', () => ({ SettingsScreen: () => null }));
import React from 'react';
import { act, render, renderHook } from '@testing-library/react-native';
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { createSurfaceRoles, useTokens } from '../../theme';
import { TabletNavigator } from '../TabletNavigator';
import { PersistentSessionProvider, usePersistentSessionHost } from '../PersistentSessionContext';
import { PersistentSessionScreen } from '../../screens/PersistentSessionScreen';
import { CardDetailContent } from '../../components/planner/CardDetailSheet';
import { getNativeStackCaptures, resetNavigationCapture } from './navigationCaptureMock';
import type { StoreApi } from 'zustand';
import type { PersistentSessionScene } from '../../store/persistentSessionScene';

let store: StoreApi<PersistentSessionScene>;
function Probe() { store = usePersistentSessionHost().store; return null; }

function SafeAreaInsetsProbe() {
  const insets = useSafeAreaInsets();
  return <Text testID="safe-area-insets">{`${insets.top}:${insets.bottom}`}</Text>;
}

const safeAreaMetrics = {
  frame: { x: 0, y: 0, width: 1024, height: 1366 },
  insets: { top: 24, right: 0, bottom: 20, left: 0 },
};

function renderTabletDetail(kind: 'card' | 'document', dimensions: { width: number; height: number }) {
  const dimensionsSpy = jest.spyOn(require('react-native'), 'useWindowDimensions').mockReturnValue({
    ...dimensions,
    scale: 1,
    fontScale: 1,
  });
  mockFocusState.current = true;
  resetNavigationCapture();
  const navigator = render(<PersistentSessionProvider><Probe /><TabletNavigator /></PersistentSessionProvider>);
  const screenName = kind === 'card' ? 'CardDetail' : 'MarkdownDocument';
  const component = getNativeStackCaptures()[0].screens.find(screen => screen.name === screenName)!.component;
  navigator.unmount();

  const testID = kind === 'card' ? 'persistent-tablet-card-sheet' : 'persistent-tablet-document-sheet';
  const route = kind === 'card' ? { params: { cardId: 'card-1' } } : { params: { documentId: 'doc-1' } };
  const screen = render(<SafeAreaProvider initialMetrics={{
    frame: { ...safeAreaMetrics.frame, ...dimensions },
    insets: safeAreaMetrics.insets,
  }}>
    <PersistentSessionProvider>{React.createElement(component, { route, navigation: { goBack: jest.fn() } })}</PersistentSessionProvider>
    <SafeAreaInsetsProbe />
  </SafeAreaProvider>);

  const detailFrame = screen.UNSAFE_getAllByType(View).find((node) => {
    const style = StyleSheet.flatten(node.props.style);
    return style.position === 'absolute' && style.width !== undefined && style.right !== undefined;
  });
  dimensionsSpy.mockRestore();
  return {
    screen,
    testID,
    style: detailFrame ? StyleSheet.flatten(detailFrame.props.style) : undefined,
    insets: screen.getByTestId('safe-area-insets').props.children,
  };
}

test.each([
  ['가로', { width: 1180, height: 820 }, 460],
  ['세로', { width: 820, height: 1180 }, 369],
])('iPad %s 카드와 문서 시트는 outerInset 위치 계약을 공유한다', (_orientation, dimensions, sheetWidth) => {
  const t = renderHook(() => useTokens()).result.current;
  const card = renderTabletDetail('card', dimensions);
  const document = renderTabletDetail('document', dimensions);

  expect(t.tabletShell.outerInset).toBe(12);
  expect(card.style).toEqual({
    position: 'absolute',
    top: 24 + t.tabletShell.outerInset,
    right: t.tabletShell.outerInset,
    bottom: t.tabletShell.outerInset,
    width: sheetWidth,
  });
  expect(document.style).toEqual(card.style);
  expect(card.insets).toBe('24:20');
  expect(card.screen.getByTestId(card.testID)).toBeTruthy();
  expect(document.screen.getByTestId(document.testID)).toBeTruthy();
  card.screen.unmount();
  document.screen.unmount();
});

test('PAS 카드 선택은 기존 스택 안에 머물고 별도 카드 상세 경로는 그대로 동작한다', () => {
  resetNavigationCapture();
  render(<PersistentSessionProvider><Probe /><TabletNavigator /></PersistentSessionProvider>);
  const stack = getNativeStackCaptures()[0];
  expect(stack.screens.map(screen => screen.name)).toEqual(['Main', 'PersistentSession', 'CardDetail', 'MarkdownDocument']);
  expect(stack.navigatorProps?.initialRouteName).toBe('Main');
  expect((stack.navigatorProps?.screenOptions as any).contentStyle).toEqual(createSurfaceRoles(renderHook(() => useTokens()).result.current).canvas.tokenStyle);
  expect(stack.screens[2].options.presentation).toBe('transparentModal');
  expect(stack.screens[3].options.presentation).toBe('transparentModal');
  const navigation = { navigate: jest.fn(), goBack: jest.fn() };
  act(() => { store.getState().open({ session_id: 'pas-1', persistent: true } as any); store.getState().selectCard('card-1'); });
  render(<PersistentSessionProvider><Probe />{React.createElement(stack.screens[1].component, { navigation })}</PersistentSessionProvider>);
  act(() => { store.getState().open({ session_id: 'pas-1', persistent: true } as any); store.getState().selectCard('card-1'); });
  const props = jest.mocked(PersistentSessionScreen).mock.calls.at(-1)![0];
  expect(props).not.toHaveProperty('onOpenCard');
  expect(props).not.toHaveProperty('onOpenSession');
  expect(navigation.navigate).not.toHaveBeenCalled();
  render(<PersistentSessionProvider>{React.createElement(stack.screens[2].component, { route: { params: { cardId: 'card-1' } }, navigation })}</PersistentSessionProvider>);
  const cardProps = jest.mocked(CardDetailContent).mock.calls.at(-1)![0];
  expect(cardProps.cardId).toBe('card-1');
  cardProps.onClose();
  expect(navigation.goBack).toHaveBeenCalledTimes(1);
  expect(store.getState()).toMatchObject({ scene: 'cards', selectedCardId: 'card-1', session: { session_id: 'pas-1' } });
  props.onHome();
  expect(store.getState().visible).toBe(false);
  expect(navigation.goBack).toHaveBeenCalledTimes(2);
});

test('iPad에서 뒤에 놓인 상세 화면의 시트와 배경을 숨긴다', () => {
  resetNavigationCapture();
  mockFocusState.current = false;
  render(<PersistentSessionProvider><Probe /><TabletNavigator /></PersistentSessionProvider>);
  const documentScreen = getNativeStackCaptures()[0].screens[3].component;
  const screen = render(<PersistentSessionProvider>{React.createElement(documentScreen, {
    route: { params: { documentId: 'doc-1' } }, navigation: { goBack: jest.fn() },
  })}</PersistentSessionProvider>);

  const tree = screen.toJSON();
  const root = Array.isArray(tree) ? tree[0] : tree;
  expect(StyleSheet.flatten(root?.props.style)).toMatchObject({ display: 'none' });
  mockFocusState.current = true;
});
