import { act, renderHook } from '@testing-library/react-native';
import { Keyboard } from 'react-native';
import { usePhoneConversationKeyboard } from '../usePhoneConversationKeyboard';
jest.mock('@react-navigation/native', () => ({ useFocusEffect: (effect: () => void) => require('react').useEffect(effect, [effect]) }));
jest.mock('../TabNavigator', () => ({ getDefaultTabBarStyle: () => ({ backgroundColor: 'transparent' }) }));

test('키보드가 숨기지 않은 탭 바는 blur 때 다음 카드 상세의 숨김을 덮지 않는다', () => {
  const parent = { setOptions: jest.fn() };
  const navigation = { getParent: () => parent, getState: () => ({ index: 0, routes: [{ key: 'pas' }] }) };
  const hook = renderHook(() => usePhoneConversationKeyboard(navigation));
  parent.setOptions({ tabBarStyle: { display: 'none' } }); // Next screen's focused effect.
  hook.unmount();
  expect(parent.setOptions).toHaveBeenCalledTimes(1);
  expect(parent.setOptions.mock.calls[0][0]).toEqual({ tabBarStyle: { display: 'none' } });
});

test('다른 탭으로 blur되어 자기 stack 최상단에 남으면 키보드로 숨긴 탭 바를 복구한다', () => {
  const listeners: Record<string, () => void> = {};
  const subscribe = jest.spyOn(Keyboard, 'addListener').mockImplementation((event, callback) => {
    listeners[event] = callback as () => void;
    return { remove: jest.fn() } as any;
  });
  const parent = { setOptions: jest.fn() };
  const navigation = { getParent: () => parent, getState: () => ({ index: 0, routes: [{ key: 'pas' }] }) };
  const hook = renderHook(() => usePhoneConversationKeyboard(navigation));
  act(() => (listeners.keyboardWillShow ?? listeners.keyboardDidShow)());
  expect(parent.setOptions).toHaveBeenLastCalledWith({ tabBarStyle: { backgroundColor: 'transparent', display: 'none' } });
  hook.unmount();
  expect(parent.setOptions).toHaveBeenLastCalledWith({ tabBarStyle: { backgroundColor: 'transparent' } });
  subscribe.mockRestore();
});

test('키보드 숨김 뒤 같은 stack 카드 상세가 숨김을 맡으면 PAS cleanup이 복원하지 않는다', () => {
  const listeners: Record<string, () => void> = {};
  const subscribe = jest.spyOn(Keyboard, 'addListener').mockImplementation((event, callback) => {
    listeners[event] = callback as () => void;
    return { remove: jest.fn() } as any;
  });
  const parent = { setOptions: jest.fn() };
  let index = 0;
  const navigation = { getParent: () => parent, getState: () => ({ index, routes: [{ key: 'pas' }, { key: 'detail' }] }) };
  const hook = renderHook(() => usePhoneConversationKeyboard(navigation));
  act(() => (listeners.keyboardWillShow ?? listeners.keyboardDidShow)());
  index = 1;
  parent.setOptions({ tabBarStyle: { backgroundColor: 'transparent', display: 'none' } });
  hook.unmount();
  expect(parent.setOptions.mock.calls.map(([options]) => options.tabBarStyle.display)).toEqual(['none', 'none']);
  expect(parent.setOptions).toHaveBeenLastCalledWith({ tabBarStyle: { backgroundColor: 'transparent', display: 'none' } });
  subscribe.mockRestore();
});
