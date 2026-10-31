import React, { useCallback, useRef, useState } from 'react';
import { useFocusEffect, useIsFocused } from '@react-navigation/native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { RecurringJobsList } from '../components/settings/RecurringJobViews';
import { useSettingsStore } from '../store/settingsStore';
import { useTokens } from '../theme';
import { usePhoneRailMode } from '../navigation/tabContract';
import { useDuoSideBand } from '../navigation/duoSideBand';
import { useRegisterDuoRailOverride } from '../navigation/phoneRailActions';

export function RecurringJobsScreen({ navigation }: { navigation: any }) {
  const serverUrl = useSettingsStore((state) => state.serverUrl);
  const t = useTokens();
  const railMode = usePhoneRailMode();
  const duo = useDuoSideBand();
  const focused = useIsFocused();
  useRegisterDuoRailOverride('jobs', duo && focused, [
    { id: 'back', label: '뒤로', icon: 'chevron-back', onPress: () => navigation.goBack() },
    { id: 'job-add', label: '새 정기 작업', icon: 'add', onPress: () => navigation.navigate('RecurringJobEditor') },
  ]);
  const [refreshKey, setRefreshKey] = useState(0);
  const wasFocused = useRef(false);
  useFocusEffect(useCallback(() => {
    if (wasFocused.current) setRefreshKey((current) => current + 1);
    else wasFocused.current = true;
  }, []));
  return <SafeAreaView edges={duo ? ['top', 'bottom', 'left'] : railMode ? ['bottom', 'left'] : ['bottom', 'left', 'right']} style={{ flex: 1, padding: t.foundation.pageInset }}>
    <RecurringJobsList
      hideCreate={duo}
      serverUrl={serverUrl}
      refreshKey={refreshKey}
      onCreate={() => navigation.navigate('RecurringJobEditor')}
      onEdit={(job) => navigation.navigate('RecurringJobEditor', { jobId: job.job_id })}
    />
  </SafeAreaView>;
}
