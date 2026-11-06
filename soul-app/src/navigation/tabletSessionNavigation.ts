import { StackActions } from '@react-navigation/native';
import { openPlannerSessionWorkspace } from '../lib/planner-folder-workspace';
import { useUIStore } from '../store/uiStore';

export function openTabletCardFromRoot(
  navigation: { dispatch(action: ReturnType<typeof StackActions.popTo>): void },
  leavePersistent: (() => void) | null,
  cardId: string,
): void {
  leavePersistent?.();
  navigation.dispatch(StackActions.popTo('Main'));
  useUIStore.getState().openCardOverlay(cardId);
}

/** 외부 세션 intent도 PAS 카드의 명시적 세션 이동과 같은 Main 호스트를 사용한다. */
export function openTabletSessionFromRoot(
  navigation: { dispatch(action: ReturnType<typeof StackActions.popTo>): void },
  leavePersistent: (() => void) | null,
  ...args: Parameters<typeof openPlannerSessionWorkspace>
) {
  leavePersistent?.();
  navigation.dispatch(StackActions.popTo('Main'));
  return openPlannerSessionWorkspace(...args);
}
