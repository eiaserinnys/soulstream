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
type Entry = 'first' | 'tab' | 'pas' | 'modal';

/** Same entry components/props as production; only the transport is a public fixture. */
export function ReviewNativeSettings({ entry: requestedEntry, onClose }: { entry?: Entry; onClose?(): void } = {}) {
  const t = useTokens();
  const params = new URLSearchParams(window.location.search);
  const entry = requestedEntry ?? params.get('entry') ?? (params.get('section') === 'pasSettings' ? 'pas' : 'modal');
  const [visible, setVisible] = useState(true);
  const close = () => { setVisible(false); onClose?.(); };
  return <View testID="native-settings-review" style={{ flex: 1, minHeight: 0, backgroundColor: t.colors.background }}>
    <PersistentSessionApiProvider createApi={createReviewApi}>
      {entry === 'first' ? <FirstConnectionSettingsScreen/> : entry === 'tab' ? <ReviewEntryShell/> : entry === 'pas'
        ? visible ? <PersistentSessionPasSettingsModal sessionId="review-pas-2" nodeId="public-node" onClose={close} /> : null
        : <SettingsModal visible={visible} onClose={close}/>}
    </PersistentSessionApiProvider>
  </View>;
}
