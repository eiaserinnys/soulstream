import { useEffect, useState } from 'react';
import { Linking } from 'react-native';
import type { DeviceType } from '../theme/useDeviceType';
import { navigationRef } from '../navigation/navigationRef';
import { useUIStore } from '../store/uiStore';

export const USAGE_WIDGET_DEEP_LINK = 'soulstream://usage';

export function isUsageWidgetDeepLink(url: string | null): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'soulstream:') return false;
    return parsed.hostname === 'usage' || parsed.pathname.replace(/^\/+|\/+$/g, '') === 'usage';
  } catch {
    return false;
  }
}

export function routeUsageWidgetDeepLink(
  device: DeviceType,
  navigateSettings: () => void,
  openTabletSettings: () => void,
): true {
  if (device === 'phone') navigateSettings();
  else openTabletSettings();
  return true;
}

/** Cold start와 실행 중 URL 이벤트를 같은 pending gate로 처리한다. */
export function useUsageWidgetDeepLink(device: DeviceType, ready: boolean) {
  const [pending, setPending] = useState(false);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let active = true;
    void Linking.getInitialURL().then((url) => {
      if (active && isUsageWidgetDeepLink(url)) setPending(true);
    });
    const subscription = Linking.addEventListener('url', ({ url }) => {
      if (isUsageWidgetDeepLink(url)) setPending(true);
    });
    return () => {
      active = false;
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    if (!pending || !ready) return;
    if (device === 'phone' && !navigationRef.isReady()) {
      const timer = setTimeout(() => setRetry((value) => value + 1), 100);
      return () => clearTimeout(timer);
    }
    routeUsageWidgetDeepLink(
      device,
      () => navigationRef.navigate('SettingsTab'),
      () => useUIStore.getState().openSettings(),
    );
    setPending(false);
  }, [device, pending, ready, retry]);
}
