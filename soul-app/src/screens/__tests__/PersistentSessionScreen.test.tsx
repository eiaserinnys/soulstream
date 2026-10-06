jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
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

let store: StoreApi<PersistentSessionScene>;
function Capture() { store = usePersistentSessionHost().store; return null; }
test('카드를 여는 동안 ChatBody의 mount·id·입력을 유지하고 기존 상세에 같은 카드를 전달한다', () => {
  const onOpenCard = jest.fn();
  const view = render(<PersistentSessionProvider><Capture /><PersistentSessionScreen onHome={jest.fn()} onOpenCard={onOpenCard} /></PersistentSessionProvider>);
  act(() => store.getState().open({ session_id: 'pas-1', display_name: '관제', persistent: true } as any));
  fireEvent.changeText(view.getByTestId('persistent-draft'), '진행 중인 입력');
  fireEvent.press(view.getByTestId('persistent-session-tasks'));
  expect(view.getByTestId('persistent-body-probe').props.active).toBe(false);
  expect(view.getByTestId('persistent-body-probe').props.sessionId).toBe('pas-1');
  fireEvent.press(view.getByTestId('choose-card'));
  fireEvent.press(view.getByTestId('open-card'));
  expect(onOpenCard).toHaveBeenCalledWith('card-1');
  expect(store.getState().selectedCardId).toBe('card-1');
  fireEvent.press(view.getByTestId('summary-back'));
  act(() => store.getState().swipe('right'));
  expect(view.getByTestId('persistent-body-probe').props.active).toBe(true);
  expect(view.getByTestId('persistent-draft').props.value).toBe('진행 중인 입력');
});
