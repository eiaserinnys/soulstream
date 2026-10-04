import React, { useState } from 'react';
import { Text, View } from 'react-native';
import { SettingsModal } from '../components/settings/SettingsModal';
import { PhoneSettingsScreen } from '../navigation/TabNavigator';
import { FirstConnectionSettingsScreen } from '../screens/SettingsScreen';
import { useTokens } from '../theme';

/** Same entry components/props as production; only the transport is a public fixture. */
export function ReviewNativeSettings() {
  const t = useTokens();
  const entry = new URLSearchParams(window.location.search).get('entry') ?? 'modal';
  const [visible, setVisible] = useState(true);
  return <View testID="native-settings-review" style={{ flex: 1, minHeight: 0, backgroundColor: t.colors.background }}>
    <Text style={{ ...t.foundation.typography.meta, color: t.colors.textMuted, padding: t.spacing.sm }}>공개 예시 데이터 · RN 웹 · iOS 실기기 미확인</Text>
    {entry === 'first' ? <FirstConnectionSettingsScreen/> : entry === 'tab' ? <PhoneSettingsScreen {...{} as any}/> : <SettingsModal visible={visible} onClose={() => setVisible(false)}/>}
  </View>;
}
