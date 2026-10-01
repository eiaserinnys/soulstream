import { useEffect, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

/**
 * 네트워크가 허용되는 앱 foreground 상태.
 *
 * active → inactive → active(Control Center)는 계속 true다. 한 번 background에
 * 들어간 뒤에는 중간 inactive에서도 false를 유지하고 최종 active에서만 복귀한다.
 */
export function useAppForegroundLifecycle(): boolean {
  const [foreground, setForeground] = useState(
    AppState.currentState !== 'background',
  );

  useEffect(() => {
    const subscription = AppState.addEventListener(
      'change',
      (next: AppStateStatus) => {
        if (next === 'background') {
          setForeground(false);
        } else if (next === 'active') {
          setForeground(true);
        }
        // inactive는 현재 값을 보존한다. background 경유 여부가 사라지지 않아야 한다.
      },
    );
    return () => subscription.remove();
  }, []);

  return foreground;
}
