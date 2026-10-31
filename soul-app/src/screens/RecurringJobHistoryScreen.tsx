import React from 'react';
import { SafeAreaView } from 'react-native-safe-area-context';

import { RecurringJobHistory } from '../components/settings/RecurringJobViews';
import { openPhoneChat } from '../navigation/phoneSessionNavigation';
import { useSettingsStore } from '../store/settingsStore';
import { useTokens } from '../theme';
import { usePhoneRailMode } from '../navigation/tabContract';
import { useIsFocused } from '@react-navigation/native';
import { useDuoSideBand } from '../navigation/duoSideBand';
import { useRegisterDuoRailOverride } from '../navigation/phoneRailActions';

export function RecurringJobHistoryScreen({ route, navigation }: { route: { params: { jobId: string } }; navigation: any }) {
  const serverUrl = useSettingsStore((state) => state.serverUrl);
  const t = useTokens();
  const railMode = usePhoneRailMode();
  const duo = useDuoSideBand();
  const focused = useIsFocused();
  useRegisterDuoRailOverride('job-history', duo && focused, [{ id: 'back', label: '뒤로', icon: 'chevron-back', onPress: () => navigation.goBack() }]);
  return <SafeAreaView edges={duo ? ['top', 'bottom', 'left'] : railMode ? ['bottom', 'left'] : ['bottom', 'left', 'right']} style={{ flex: 1, padding: t.foundation.pageInset }}>
    <RecurringJobHistory
      serverUrl={serverUrl}
      jobId={route.params.jobId}
      onOpenSession={(sessionId) => openPhoneChat(navigation, sessionId)}
    />
  </SafeAreaView>;
}
