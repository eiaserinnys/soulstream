jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
jest.mock('@expo/vector-icons/MaterialCommunityIcons', () => 'MaterialCommunityIcons');
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
  const { Pressable, View } = require('react-native');
  return { PersistentSessionTaskList: ({ onOpenCard, visible = true }: any) => <View testID="persistent-task-list-mock"
    style={{ display: visible ? 'flex' : 'none' }}><Pressable testID="choose-card" onPress={() => onOpenCard('card-1')} /></View> };
});
jest.mock('../../components/persistent/SwayCharacter', () => ({ SwayCharacter: () => null }));
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
  act(() => body.props.onComposerLayout(
    { x: 0, y: 644, width: 480, height: 76 },
    { x: 0, y: 20, width: 480, height: 56 },
  ));
  const before = StyleSheet.flatten(view.getByTestId('persistent-session-character-seat').props.style);
  const line = StyleSheet.flatten(view.getByTestId('persistent-session-baseline').props.style);
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
  const view = render(<PersistentSessionProvider><Capture /><PersistentSessionScreen onHome={jest.fn()} onOpenCard={jest.fn()} /></PersistentSessionProvider>);
  act(() => {
    store.getState().open({ session_id: 'pas-baseline', display_name: '관제', persistent: true } as any);
    const request = useChatStore.getState().beginPersistentDisplaySettingsLoad('pas-baseline');
    useChatStore.getState().finishPersistentDisplaySettingsLoad('pas-baseline', request, {
      show_character: true, animate_character: true, show_generation_separator: true, show_jev_candidates: true, show_turn_usage: true,
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
  const view = render(<PersistentSessionProvider><Capture /><PersistentSessionScreen onHome={jest.fn()} onOpenCard={jest.fn()} /></PersistentSessionProvider>);
  act(() => {
    store.getState().open({ session_id: `pas-toggle-${shown}`, display_name: '관제', persistent: true } as any);
    const sessionId = `pas-toggle-${shown}`;
    const request = useChatStore.getState().beginPersistentDisplaySettingsLoad(sessionId);
    useChatStore.getState().finishPersistentDisplaySettingsLoad(sessionId, request, {
      show_character: shown, animate_character: true, show_generation_separator: true, show_jev_candidates: true, show_turn_usage: true,
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
  const view = render(<PersistentSessionProvider><PersistentSessionScreen onHome={jest.fn()} onOpenCard={jest.fn()} /></PersistentSessionProvider>);
  act(() => view.getByTestId('persistent-session-screen').props.onLayout());
  const column = StyleSheet.flatten(view.getByTestId('persistent-session-conversation').props.style);
  expect(column.left).toBe(20);
  expect(column.width).toBe(350);
  expect(view.queryByTestId('persistent-session-character-seat')).toBeNull();
  view.unmount();
  measure.mockRestore();
});

test('PAS 헤더 액션은 테두리와 바탕 없는 원형 버튼 표면을 쓴다', () => {
  mockDevice = 'phone';
  const view = render(<PersistentSessionProvider><PersistentSessionScreen onHome={jest.fn()} onOpenCard={jest.fn()} /></PersistentSessionProvider>);
  for (const testID of [
    'persistent-session-home-visual',
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
  const header = StyleSheet.flatten(view.getByTestId('persistent-summary-header').props.style);
  expect(header.paddingHorizontal + (44 - 32) / 2).toBe(20);
  fireEvent.press(view.getByLabelText('목록으로'));
  expect(store.getState().selectedCardId).toBeNull();
  view.unmount();
});

test.each([[1180, 820], [1194, 834], [820, 1180], [834, 1194]])('iPad %s×%s 목록의 초상 끝은 헤더 원 끝이며 요약 위치와 목록 복귀는 유지한다', (width, height) => {
  mockDevice = height > width ? 'tabletPortrait' : 'tabletLandscape';
  const dimensions = jest.spyOn(require('react-native'), 'useWindowDimensions').mockReturnValue({ width, height, scale: 1, fontScale: 1 });
  const measure = jest.spyOn((View as any).prototype, 'measureInWindow').mockImplementation(function(this: any, callback: any) {
    if (this.props.testID === 'persistent-session-screen') callback(0, 24, width, height - 24);
  });
  const view = render(<PersistentSessionProvider><Capture /><PersistentSessionScreen onHome={jest.fn()} onOpenCard={jest.fn()} /></PersistentSessionProvider>);
  act(() => { view.getByTestId('persistent-session-screen').props.onLayout(); store.getState().open({ session_id: 'pas-1' } as any); store.getState().toggleScene(); });
  const list = StyleSheet.flatten(view.getByTestId('persistent-session-card-panel').props.style);
  expect(width - list.right - list.paddingHorizontal).toBe(width - 20);
  fireEvent.press(view.getByTestId('choose-card'));
  const summary = StyleSheet.flatten(view.getByTestId('persistent-session-card-panel').props.style);
  expect(summary.right).toBe(height > width ? 20 : width - (width - 480) / 2 - 480 - 24 - 318);
  const back = view.getByTestId('persistent-summary-back');
  const wrapper = StyleSheet.flatten(view.getByTestId('persistent-summary-header').props.style);
  expect(wrapper.paddingHorizontal + (48 - 32) / 2).toBe(20);
  fireEvent.press(back);
  expect(StyleSheet.flatten(view.getByTestId('persistent-session-card-panel').props.style).right).toBe(list.right);
  view.unmount(); measure.mockRestore(); dimensions.mockRestore();
});

test('카드 요약을 열어도 작업 목록을 숨긴 채 유지하고 목록 복귀 때 다시 보인다', () => {
  mockDevice = 'phone';
  const view = render(<PersistentSessionProvider><Capture /><PersistentSessionScreen onHome={jest.fn()} onOpenCard={jest.fn()} /></PersistentSessionProvider>);
  act(() => { store.getState().open({ session_id: 'pas-1' } as any); store.getState().toggleScene(); });
  fireEvent.press(view.getByTestId('choose-card'));

  expect(StyleSheet.flatten(view.getByTestId('persistent-task-list-mock', { includeHiddenElements: true }).props.style).display).toBe('none');
  expect(view.getByTestId('persistent-summary-header')).toBeTruthy();
  fireEvent.press(view.getByTestId('persistent-summary-back'));
  expect(StyleSheet.flatten(view.getByTestId('persistent-task-list-mock').props.style).display).toBe('flex');
  view.unmount();
});
