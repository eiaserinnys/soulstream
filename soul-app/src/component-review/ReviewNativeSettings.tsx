import React, { useState } from 'react';
import { View } from 'react-native';
import { SettingsModal } from '../components/settings/SettingsModal';
import { PersistentSessionPasSettingsModal } from '../components/settings/PersistentSessionPasSettingsModal';
import { PersistentSessionApiProvider } from '../components/settings/persistentSessionApi';
import { FirstConnectionSettingsScreen } from '../screens/SettingsScreen';
import { nativeSettingsReviewApi } from './native-settings-fixtures';
import { useTokens } from '../theme';
import { ReviewEntryShell } from './ReviewEntryShell';

const createReviewApi = () => nativeSettingsReviewApi;

/** Same entry components/props as production; only the transport is a public fixture. */
export function ReviewNativeSettings() {
  const t = useTokens();
  const params = new URLSearchParams(window.location.search);
  const entry = params.get('entry') ?? (params.get('section') === 'pasSettings' ? 'pas' : 'modal');
  const [visible, setVisible] = useState(true);
  return <View testID="native-settings-review" style={{ flex: 1, minHeight: 0, backgroundColor: t.colors.background }}>
    <PersistentSessionApiProvider createApi={createReviewApi}>
      {entry === 'first' ? <FirstConnectionSettingsScreen/> : entry === 'tab' ? <ReviewEntryShell/> : entry === 'pas'
        ? visible ? <PersistentSessionPasSettingsModal sessionId="review-pas-1" nodeId="public-node" onClose={() => setVisible(false)} /> : null
        : <SettingsModal visible={visible} onClose={() => setVisible(false)}/>}
    </PersistentSessionApiProvider>
  </View>;
}
