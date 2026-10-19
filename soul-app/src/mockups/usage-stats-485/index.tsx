import React, { useState } from 'react';
import { Text, View, useWindowDimensions } from 'react-native';
import {
  SafeAreaFrameContext,
  SafeAreaInsetsContext,
  type EdgeInsets,
} from 'react-native-safe-area-context';
import { SettingsScreen } from '../../screens/SettingsScreen';
import { GlassButton } from '../../components/GlassSurface';
import { useSettingsStore } from '../../store/settingsStore';
import { TABLET_BREAKPOINT, useTokens } from '../../theme';
import {
  UsageStatsPreviewProvider,
} from '../../components/settings/usage-stats/UsageStatsSettingsSection';
import { createUsageStatsMockFetch, type PreviewState } from './mock-api';
import { MockupShell } from '../MockupShell';

function queryOptions(): { state: PreviewState; period: 'week' | 'month' | 'all'; date: string | null; measure: 'tokens' | 'cost' } {
  const params = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
  const requestedState = params?.get('state');
  const allowedStates: PreviewState[] = ['ready', 'loading', 'empty', 'error', 'forbidden', 'backfilling'];
  const state = allowedStates.includes(requestedState as PreviewState) ? requestedState as PreviewState : 'ready';
  const requestedPeriod = params?.get('period');
  const period = requestedPeriod === 'month' || requestedPeriod === 'all' ? requestedPeriod : 'week';
  const date = params?.get('date') ?? null;
  const measure = params?.get('measure') === 'cost' ? 'cost' : 'tokens';
  return { state, period, date, measure };
}

function SettingsPreview() {
  const { width, height } = useWindowDimensions();
  const t = useTokens();
  const [closed, setClosed] = useState(false);
  const [initialized] = useState(() => {
    useSettingsStore.setState({ serverUrl: '' });
    globalThis.fetch = createUsageStatsMockFetch(queryOptions().state, globalThis.fetch);
    return true;
  });
  const options = queryOptions();
  const insets: EdgeInsets = width >= TABLET_BREAKPOINT
    ? { top: 24, right: 0, bottom: 20, left: 0 }
    : { top: 47, right: 0, bottom: 34, left: 0 };
  const frame = { x: 0, y: 0, width, height };
  void initialized;

  return <SafeAreaFrameContext.Provider value={frame}>
    <SafeAreaInsetsContext.Provider value={insets}>
      <View style={{ flex: 1, backgroundColor: t.colors.background }}>
        {closed ? <View testID="usage-stats-mockup-closed" style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: t.spacing.md }}>
          <Text style={{ ...t.foundation.typography.body, color: t.colors.textSecondary }}>설정 화면이 닫혔습니다.</Text>
          <GlassButton onPress={() => setClosed(false)}><Text style={{ ...t.foundation.typography.body, color: t.colors.textPrimary }}>다시 열기</Text></GlassButton>
        </View> : <UsageStatsPreviewProvider initialPeriod={options.period} initialDate={options.date} initialMeasure={options.measure}>
          <SettingsScreen category="usage-stats" showAdmin={false} onClose={() => setClosed(true)} />
        </UsageStatsPreviewProvider>}
      </View>
    </SafeAreaInsetsContext.Provider>
  </SafeAreaFrameContext.Provider>;
}

export default function UsageStats485Mockup() {
  return <MockupShell><SettingsPreview /></MockupShell>;
}
