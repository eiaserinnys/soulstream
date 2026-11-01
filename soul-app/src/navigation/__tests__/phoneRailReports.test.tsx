jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
jest.mock('@expo/vector-icons/MaterialCommunityIcons', () => 'MaterialCommunityIcons');
jest.mock('../../components/persistent/usePasContextMenu', () => ({ usePasContextMenu: () => jest.fn() }));

import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import { NavigationContainer } from '@react-navigation/native';
import { PersistentSessionProvider, usePersistentSessionHost } from '../PersistentSessionContext';
import { PhoneRailTabCluster } from '../TabNavigator';
import type { PersistentSessionScene } from '../../store/persistentSessionScene';
import type { StoreApi } from 'zustand';

let store: StoreApi<PersistentSessionScene>;
function Capture() { store = usePersistentSessionHost().store; return null; }

test('듀오 PAS 레일의 보고 버튼은 개수와 장면, 빈 상태를 반영한다', () => {
  const view = render(<PersistentSessionProvider><Capture /><NavigationContainer>
    <PhoneRailTabCluster active="PersistentTab" onSelect={() => store.getState().toggleScene()} duoSideBand />
  </NavigationContainer></PersistentSessionProvider>);
  act(() => {
    store.getState().open({ session_id: 'pas' } as any);
    store.getState().setSessions([{ session_id: 'pas' }, { session_id: 'pas-2' }] as any);
    store.getState().setReportAvailability(2, true);
  });
  expect(view.getByTestId('phone-rail-pas-reports-badge').props.children).toBe(2);
  fireEvent.press(view.getByTestId('phone-rail-pas-reports'));
  expect(store.getState().scene).toBe('reports');
  expect(view.getByTestId('phone-rail-pas-reports').props.accessibilityState.selected).toBe(true);
  expect(view.getByTestId('phone-tab-PersistentTab').props.accessibilityLabel).toBe('영구 세션 선택');
  const back = view.getByTestId('phone-rail-action-back');
  expect(back.props.accessibilityLabel).toBe('PAS 대화로 돌아가기');
  fireEvent.press(back);
  expect(store.getState().scene).toBe('conversation');
  act(() => store.getState().setReportAvailability(0, false));
  expect(view.queryByTestId('phone-rail-pas-reports-badge')).toBeNull();
  expect(view.getByTestId('phone-rail-pas-reports').props.accessibilityState.disabled).toBe(true);
  expect(view.getByTestId('phone-rail-pas-reports').props.accessibilityLabel).toBe('지금의 보고 없음');
});
