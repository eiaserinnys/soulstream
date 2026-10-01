import { createNavigationContainerRef } from '@react-navigation/native';
import type { RootTabParamList } from './TabNavigator';

/**
 * NavigationContainer의 외부 ref.
 *
 * push 알림 탭 핸들러 등 컴포넌트 트리 바깥(Notifications listener)에서
 * navigation을 트리거할 때 사용한다. App.tsx에서 NavigationContainer에 주입.
 *
 * phone 환경에서는 이 ref로 ChatTab.Chat 진입을 강제할 수 있고,
 * tablet 환경에서는 NavigationContainer가 SplitLayout을 그리므로 ref.navigate가
 * no-op이 되며, 별도로 uiStore.setActiveSessionId를 호출해야 한다.
 */
export const navigationRef = createNavigationContainerRef<RootTabParamList>();
