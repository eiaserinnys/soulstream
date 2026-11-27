import { useEffect, useRef, useState } from 'react';
import { createApiClient } from '../../api/client';
import { useAuthStore } from '../../store/authStore';
import { useSettingsStore } from '../../store/settingsStore';
import type { Appearance } from '../../../../packages/soul-ui/src/lib/user-preferences-envelope';
import type { WallpaperSettings } from '../../../../packages/soul-ui/src/lib/wallpaper-settings';

export function useDisplayPreferenceActions() {
  const serverUrl = useSettingsStore(state => state.serverUrl);
  const wallpaper = useSettingsStore(state => state.wallpaper);
  const jwt = useAuthStore(state => state.jwt);
  const preferencesRevision = useRef(0);
  const identity = useRef({ serverUrl, jwt });
  identity.current = { serverUrl, jwt };
  const [backgroundStatus, setBackgroundStatus] = useState<string | null>(null);
  useEffect(() => () => { ++preferencesRevision.current; }, []);
  useEffect(() => { ++preferencesRevision.current; setBackgroundStatus(null); }, [serverUrl, jwt]);
  async function savePreferences(nextAppearance: Appearance, nextWallpaper: WallpaperSettings) {
    const revision = ++preferencesRevision.current;
    const scope = identity.current;
    setBackgroundStatus('이 기기에 적용했습니다.');
    if (!scope.serverUrl || !scope.jwt) return;
    try {
      const response = await createApiClient(scope.serverUrl).putUserPreferences({ appearance: nextAppearance, wallpaper: nextWallpaper });
      if (revision !== preferencesRevision.current || identity.current.serverUrl !== scope.serverUrl || identity.current.jwt !== scope.jwt) return;
      useSettingsStore.getState().applyUserPreferences(response.preferences);
      setBackgroundStatus('이 기기와 서버에 적용했습니다.');
    } catch { if (revision === preferencesRevision.current && identity.current.serverUrl === scope.serverUrl && identity.current.jwt === scope.jwt) setBackgroundStatus('이 기기에 적용했습니다. 서버 동기화에 실패했습니다.'); }
  }
  async function handleAppearanceChange(next: Appearance) {
    useSettingsStore.getState().setAppearance(next);
    await savePreferences(next, wallpaper);
  }
  return { preferencesRevision, identity, backgroundStatus, setBackgroundStatus, savePreferences, handleAppearanceChange };
}
