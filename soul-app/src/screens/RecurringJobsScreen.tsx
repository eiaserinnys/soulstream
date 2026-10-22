import React, { useCallback, useRef, useState } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { RecurringJobsList } from '../components/settings/RecurringJobViews';
import { useSettingsStore } from '../store/settingsStore';
import { useTokens } from '../theme';
import { usePhoneRailMode } from '../navigation/tabContract';

export function RecurringJobsScreen({ navigation }: { navigation: any }) {
  const serverUrl = useSettingsStore((state) => state.serverUrl);
  const t = useTokens();
  const railMode = usePhoneRailMode();
  const [refreshKey, setRefreshKey] = useState(0);
  const wasFocused = useRef(false);
  useFocusEffect(useCallback(() => {
    if (wasFocused.current) setRefreshKey((current) => current + 1);
    else wasFocused.current = true;
  }, []));
  return <SafeAreaView edges={railMode ? ['bottom', 'left'] : ['bottom', 'left', 'right']} style={{ flex: 1, padding: t.foundation.pageInset }}>
    <RecurringJobsList
      serverUrl={serverUrl}
      refreshKey={refreshKey}
      onCreate={() => navigation.navigate('RecurringJobEditor')}
      onEdit={(job) => navigation.navigate('RecurringJobEditor', { jobId: job.job_id })}
    />
  </SafeAreaView>;
}
