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
import { StyleSheet } from 'react-native';
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
