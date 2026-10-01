import React from 'react';
import { SafeAreaView } from 'react-native-safe-area-context';

import { RecurringJobEditor } from '../components/settings/RecurringJobViews';
import { useSettingsStore } from '../store/settingsStore';
import { useTokens } from '../theme';

export function RecurringJobEditorScreen({ route, navigation }: { route: { params?: { jobId?: string } }; navigation: any }) {
  const serverUrl = useSettingsStore((state) => state.serverUrl);
  const t = useTokens();
  return <SafeAreaView edges={['left', 'right', 'bottom']} style={{ flex: 1, paddingHorizontal: t.foundation.pageInset }}>
    <RecurringJobEditor
      serverUrl={serverUrl}
      jobId={route.params?.jobId}
      onDone={() => navigation.goBack()}
      onOpenHistory={(jobId) => navigation.navigate('RecurringJobHistory', { jobId })}
    />
  </SafeAreaView>;
}
