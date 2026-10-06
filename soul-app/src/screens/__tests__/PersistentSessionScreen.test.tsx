jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
let mockDevice = 'phone';
jest.mock('../../theme/useDeviceType', () => ({ useDeviceType: () => mockDevice, deviceTypeToBaseKey: (device: string) => device === 'phone' ? 'phone' : 'tablet' }));
jest.mock('../../components/chat/ChatBody', () => {
  const React = require('react'); const { View, TextInput } = require('react-native');
  return { ChatBody: (props: any) => {
    const [draft, setDraft] = React.useState('');
    return <View testID="persistent-body-probe" {...props}><TextInput testID="persistent-draft" value={draft} onChangeText={setDraft} /></View>;
  } };
});
jest.mock('../../components/persistent/PersistentSessionTaskList', () => {
  const { Pressable } = require('react-native');
  return { PersistentSessionTaskList: ({ onOpenCard }: any) => <Pressable testID="choose-card" onPress={() => onOpenCard('card-1')} /> };
});
jest.mock('../../components/planner/CardDetailSheet', () => {
  const { Pressable, View } = require('react-native');
  return { CardDetailContent: ({ onOpenCard, onClose }: any) => <View><Pressable testID="open-card" onPress={onOpenCard} /><Pressable testID="summary-back" onPress={onClose} /></View> };
});
jest.mock('../../components/settings/PersistentSessionPasSettingsModal', () => ({ PersistentSessionPasSettingsModal: () => null }));
jest.mock('../SettingsScreen', () => ({ SettingsScreen: () => null }));

import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import { PersistentSessionProvider, usePersistentSessionHost } from '../../navigation/PersistentSessionContext';
import { PersistentSessionScreen } from '../PersistentSessionScreen';
import type { PersistentSessionScene } from '../../store/persistentSessionScene';
import type { StoreApi } from 'zustand';
import { StyleSheet, View } from 'react-native';
import { useChatStore } from '../../store/chatStore';

let store: StoreApi<PersistentSessionScene>;
function Capture() { store = usePersistentSessionHost().store; return null; }
test('카드를 여는 동안 ChatBody의 mount·id·입력을 유지하고 기존 상세에 같은 카드를 전달한다', () => {
  const onOpenCard = jest.fn();
  const view = render(<PersistentSessionProvider><Capture /><PersistentSessionScreen onHome={jest.fn()} onOpenCard={onOpenCard} /></PersistentSessionProvider>);
  act(() => store.getState().open({ session_id: 'pas-1', display_name: '관제', persistent: true } as any));
  fireEvent.changeText(view.getByTestId('persistent-draft'), '진행 중인 입력');
  fireEvent.press(view.getByTestId('persistent-session-tasks'));
  expect(view.getByTestId('persistent-body-probe', { includeHiddenElements: true }).props.active).toBe(false);
  expect(view.getByTestId('persistent-body-probe', { includeHiddenElements: true }).props.sessionId).toBe('pas-1');
  fireEvent.press(view.getByTestId('choose-card'));
  fireEvent.press(view.getByTestId('open-card'));
  expect(onOpenCard).toHaveBeenCalledWith('card-1');
  expect(store.getState().selectedCardId).toBe('card-1');
  fireEvent.press(view.getByTestId('summary-back'));
  act(() => store.getState().swipe('right'));
  expect(view.getByTestId('persistent-body-probe').props.active).toBe(true);
  expect(view.getByTestId('persistent-draft').props.value).toBe('진행 중인 입력');
});

test('열 크기가 같은 x 이동도 다시 실측해 몸 하단과 선 접점을 유지한다', () => {
  mockDevice = 'tabletLandscape';
  const dimensions = jest.spyOn(require('react-native'), 'useWindowDimensions').mockReturnValue({ width: 1180, height: 820, scale: 1, fontScale: 1 });
  let width = 1180;
  const measure = jest.spyOn((View as any).prototype, 'measureInWindow').mockImplementation(function(this: any, callback: any) {
    if (this.props.testID === 'persistent-session-screen') callback(0, 24, width, 796);
    else if (this.props.testID === 'persistent-session-conversation') callback((width - 480) / 2, 100, 480, 720);
  });
  const view = render(<PersistentSessionProvider><Capture /><PersistentSessionScreen onHome={jest.fn()} onOpenCard={jest.fn()} /></PersistentSessionProvider>);
  act(() => {
    store.getState().open({ session_id: 'pas-1', display_name: '관제', persistent: true } as any);
    const request = useChatStore.getState().beginPersistentDisplaySettingsLoad('pas-1');
    useChatStore.getState().finishPersistentDisplaySettingsLoad('pas-1', request, { show_character: true, animate_character: true, show_generation_separator: true, show_jev_candidates: true, show_turn_usage: true });
  });
  act(() => view.getByTestId('persistent-session-screen').props.onLayout());
  const body = view.getByTestId('persistent-body-probe');
  fireEvent(body, 'composerLayout', { nativeEvent: { layout: { x: 0, y: 644, width: 480, height: 76 } } });
  const before = StyleSheet.flatten(view.getByTestId('persistent-session-character-seat').props.style);
  const line = StyleSheet.flatten(view.getByTestId('persistent-session-baseline').props.style);
  expect(before.width).toBe(152);
  expect(before.top + before.height).toBe(line.top + 1);
  const toggle = StyleSheet.flatten(view.getByTestId('persistent-session-character-toggle-seat').props.style);
  expect(toggle.top + 48 / 2).toBe(line.top + 48 / 2);
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

test('phone의 원고형 열은 공통 pageInset으로 본문과 입력의 가장자리를 지킨다', () => {
  mockDevice = 'phone';
  const measure = jest.spyOn((View as any).prototype, 'measureInWindow').mockImplementation(function(this: any, callback: any) {
    if (this.props.testID === 'persistent-session-screen') callback(0, 47, 390, 715);
  });
  const view = render(<PersistentSessionProvider><PersistentSessionScreen onHome={jest.fn()} onOpenCard={jest.fn()} /></PersistentSessionProvider>);
  act(() => view.getByTestId('persistent-session-screen').props.onLayout());
  const column = StyleSheet.flatten(view.getByTestId('persistent-session-conversation').props.style);
  expect(column.left).toBe(20);
  expect(column.width).toBe(350);
  expect(view.queryByTestId('persistent-session-character-seat')).toBeNull();
  view.unmount();
  measure.mockRestore();
});

test('phone 카드 목록은 제목과 같은 가장자리·종이 바탕을 쓰고 요약에는 목록으로 버튼이 있다', () => {
  mockDevice = 'phone';
  const view = render(<PersistentSessionProvider><Capture /><PersistentSessionScreen onHome={jest.fn()} onOpenCard={jest.fn()} /></PersistentSessionProvider>);
  act(() => { store.getState().open({ session_id: 'pas-1' } as any); store.getState().toggleScene(); });
  const panel = StyleSheet.flatten(view.getByTestId('persistent-session-card-panel').props.style);
  const paper = StyleSheet.flatten(view.getByTestId('persistent-session-safe-area').props.style);
  expect(panel.paddingHorizontal).toBe(20);
  expect(panel.paddingTop).toBeGreaterThan(0);
  expect(panel.backgroundColor).toBe(paper.backgroundColor);
  fireEvent.press(view.getByTestId('choose-card'));
  fireEvent.press(view.getByLabelText('목록으로'));
  expect(store.getState().selectedCardId).toBeNull();
  view.unmount();
});
