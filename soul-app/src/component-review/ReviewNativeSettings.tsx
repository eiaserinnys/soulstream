import React, { useState } from 'react';
import { View } from 'react-native';
import { SettingsModal } from '../components/settings/SettingsModal';
import { FirstConnectionSettingsScreen } from '../screens/SettingsScreen';
import { useTokens } from '../theme';
import { ReviewEntryShell } from './ReviewEntryShell';

/** Same entry components/props as production; only the transport is a public fixture. */
export function ReviewNativeSettings() {
  const t = useTokens();
  const entry = new URLSearchParams(window.location.search).get('entry') ?? 'modal';
  const [visible, setVisible] = useState(true);
  return <View testID="native-settings-review" style={{ flex: 1, minHeight: 0, backgroundColor: t.colors.background }}>
    {entry === 'first' ? <FirstConnectionSettingsScreen/> : entry === 'tab' ? <ReviewEntryShell/> : <SettingsModal visible={visible} onClose={() => setVisible(false)}/>}
  </View>;
}
