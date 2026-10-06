import { act, renderHook } from '@testing-library/react-native';
import { Keyboard } from 'react-native';
import { usePhoneConversationKeyboard } from '../usePhoneConversationKeyboard';
jest.mock('@react-navigation/native', () => ({ useFocusEffect: (effect: () => void) => require('react').useEffect(effect, [effect]) }));
jest.mock('../TabNavigator', () => ({ getDefaultTabBarStyle: () => ({ backgroundColor: 'transparent' }) }));

test('키보드가 숨기지 않은 탭 바는 blur 때 다음 카드 상세의 숨김을 덮지 않는다', () => {
  const parent = { setOptions: jest.fn() };
  const navigation = { getParent: () => parent };
  const hook = renderHook(() => usePhoneConversationKeyboard(navigation));
  parent.setOptions({ tabBarStyle: { display: 'none' } }); // Next screen's focused effect.
  hook.unmount();
  expect(parent.setOptions).toHaveBeenCalledTimes(1);
  expect(parent.setOptions.mock.calls[0][0]).toEqual({ tabBarStyle: { display: 'none' } });
});

test('현재 대화가 키보드 때문에 숨긴 탭 바는 blur 때 기존 규칙대로 복구한다', () => {
  const listeners: Record<string, () => void> = {};
  const subscribe = jest.spyOn(Keyboard, 'addListener').mockImplementation((event, callback) => {
    listeners[event] = callback as () => void;
    return { remove: jest.fn() } as any;
  });
  const parent = { setOptions: jest.fn() };
  const navigation = { getParent: () => parent };
  const hook = renderHook(() => usePhoneConversationKeyboard(navigation));
  act(() => (listeners.keyboardWillShow ?? listeners.keyboardDidShow)());
  expect(parent.setOptions).toHaveBeenLastCalledWith({ tabBarStyle: { backgroundColor: 'transparent', display: 'none' } });
  hook.unmount();
  expect(parent.setOptions).toHaveBeenLastCalledWith({ tabBarStyle: { backgroundColor: 'transparent' } });
  subscribe.mockRestore();
});
