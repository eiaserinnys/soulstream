import { useCallback } from 'react';
import { Keyboard, Platform } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { getDefaultTabBarStyle } from './TabNavigator';
import { useTokens } from '../theme';

/** 포커스된 대화에서만 등록하는 기존 phone 키보드/탭 표시 계약. */
export function usePhoneConversationKeyboard(navigation: { getParent(): { setOptions(options: unknown): void } | undefined; getState(): { index: number; routes: { key: string }[] } }) {
  const t = useTokens();
  // 키보드 등장 시 탭 바를 숨겨 KAV의 effective bottom = 화면 바닥이 되게 한다.
  // tabBarHideOnKeyboard는 iPad iOS 18+에서 hide 애니메이션 잔존 버그(둥근 상단 edge가
  // 키보드 위에 남음)가 있어 사용하지 않는다. 대신 useFocusEffect 안에서 Keyboard
  // 리스너로 tabBarStyle.display를 동적 토글하여 같은 UX를 얻으면서 잔존 edge를 피한다.
  useFocusEffect(
    useCallback(() => {
      const parent = navigation.getParent();
      const initialStack = navigation.getState();
      const routeKey = initialStack.routes[initialStack.index].key;
      const visible = getDefaultTabBarStyle(t.colors);
      const hidden = { ...visible, display: 'none' as const };
      let hiddenByKeyboard = false;
      // iOS는 keyboardWill* 가 키보드 애니메이션과 동기. Android는 Will* 미지원이라 Did* 사용.
      const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
      const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
      const showSub = Keyboard.addListener(showEvt, () => {
        hiddenByKeyboard = true;
        parent?.setOptions({ tabBarStyle: hidden });
      });
      const hideSub = Keyboard.addListener(hideEvt, () => {
        hiddenByKeyboard = false;
        parent?.setOptions({ tabBarStyle: visible });
      });
      return () => {
        showSub.remove();
        hideSub.remove();
        // 위에 push된 화면이 숨김을 맡은 경우만 보존한다. pop과 탭 전환은 복원한다.
        const stack = navigation.getState();
        const coveredByNextScreen = stack.routes.some(route => route.key === routeKey)
          && stack.routes[stack.index].key !== routeKey;
        if (hiddenByKeyboard && !coveredByNextScreen) parent?.setOptions({ tabBarStyle: visible });
      };
    }, [navigation, t.colors])
  );

}
