import React, { useEffect, useState } from 'react';
import { useDeviceType } from '../../theme/useDeviceType';
import { useSessionsStream } from '../../hooks/useSessionsStream';
import { useNodeConnectivityStream } from '../../hooks/useNodeConnectivityStream';
import {
  hasUIStoreHydrationFailed,
  subscribeUIStoreHydrationFailure,
  useUIStore,
} from '../../store/uiStore';
import { ThreePaneLayout } from './ThreePaneLayout';
import { TwoPaneWithDrawer } from './TwoPaneWithDrawer';
import { SearchKeyboardCommandsHost } from '../search/SearchKeyboardCommandsHost';

/**
 * 태블릿용 split 레이아웃 진입점.
 *
 * useDeviceType에 따라 가로(3-pane) / 세로(2-pane + drawer)로 자동 분기한다.
 * 폰 사이즈는 RootNavigator에서 따로 TabNavigator로 분기되므로 여기엔 도달하지 않는다.
 *
 * 폰 TabNavigator가 useSessionsStream을 탭 레벨에서 마운트하던 것과 같은 역할을
 * 본 컴포넌트가 split 레이아웃에서 담당한다 — 카탈로그/세션 리스트 SSE를 1회 구독.
 */
export function SplitLayout() {
  useSessionsStream();
  useNodeConnectivityStream();
  const device = useDeviceType();
  const hydrated = useUIStoreHydrated();

  if (!hydrated) return null;

  return (
    <SearchKeyboardCommandsHost>
      {device === 'tabletLandscape'
        ? <ThreePaneLayout />
        : <TwoPaneWithDrawer />}
    </SearchKeyboardCommandsHost>
  );
}

function useUIStoreHydrated(): boolean {
  const [hydrated, setHydrated] = useState(
    isUIStoreHydrationReady,
  );

  useEffect(() => {
    const refresh = () => setHydrated(isUIStoreHydrationReady());
    const unsubscribeStart = useUIStore.persist.onHydrate(refresh);
    const unsubscribeFinish = useUIStore.persist.onFinishHydration(refresh);
    const unsubscribeFailure = subscribeUIStoreHydrationFailure(refresh);
    refresh();
    return () => {
      unsubscribeStart();
      unsubscribeFinish();
      unsubscribeFailure();
    };
  }, []);

  return hydrated;
}

function isUIStoreHydrationReady(): boolean {
  return useUIStore.persist.hasHydrated() || hasUIStoreHydrationFailed();
}
