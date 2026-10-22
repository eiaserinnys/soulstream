import React from 'react';
import { SafeAreaView } from 'react-native-safe-area-context';

import { RecurringJobHistory } from '../components/settings/RecurringJobViews';
import { openPhoneChat } from '../navigation/phoneSessionNavigation';
import { useSettingsStore } from '../store/settingsStore';
import { useTokens } from '../theme';
import { usePhoneRailMode } from '../navigation/tabContract';

export function RecurringJobHistoryScreen({ route, navigation }: { route: { params: { jobId: string } }; navigation: any }) {
  const serverUrl = useSettingsStore((state) => state.serverUrl);
  const t = useTokens();
  const railMode = usePhoneRailMode();
  return <SafeAreaView edges={railMode ? ['bottom', 'left'] : ['bottom', 'left', 'right']} style={{ flex: 1, padding: t.foundation.pageInset }}>
    <RecurringJobHistory
      serverUrl={serverUrl}
      jobId={route.params.jobId}
      onOpenSession={(sessionId) => openPhoneChat(navigation, sessionId)}
    />
  </SafeAreaView>;
}
