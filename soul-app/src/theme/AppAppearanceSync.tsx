import { useEffect } from 'react';
import { Appearance, Platform } from 'react-native';
import { useSettingsStore } from '../store/settingsStore';

/**
 * 앱 외양 설정을 iOS 네이티브 외양으로도 내려보낸다.
 * native 리퀴드 글래스(UIKit)는 앱 테마를 모르므로, 이 동기화가 있어야
 * 적응형 유리와 iOS 동적 색이 배경 밝기에 맞춰 움직인다.
 * 웹·Android에는 setColorScheme을 호출하지 않는다.
 */
export function AppAppearanceSync() {
  const appearance = useSettingsStore((state) => state.appearance);
  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    Appearance.setColorScheme(appearance === 'system' ? 'unspecified' : appearance);
  }, [appearance]);
  return null;
}
