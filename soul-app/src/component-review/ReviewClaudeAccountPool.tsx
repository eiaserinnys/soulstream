import React, { useMemo, useState } from 'react';
import { ScrollView, useWindowDimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AIBackendSettingsSection } from '../components/settings/AIBackendSettingsSection';
import { SettingsWorkspaceContext, type SettingsJobDestination, type SettingsPersistentDestination } from '../components/settings/SettingsWorkspaceContext';
import type { SettingsCategory } from '../components/settings/settingsCategories';
import { TABLET_BREAKPOINT, useDeviceType, useTokens } from '../theme';
import { createClaudePoolReviewApi } from './claude-account-pool-fixtures';

export function ReviewClaudeAccountPool() {
  const t = useTokens();
  const { width } = useWindowDimensions();
  const device = useDeviceType();
  const wide = device !== 'phone' && width >= TABLET_BREAKPOINT;
  const columns = width - (wide ? 240 : 0) >= 700;
  const api = useMemo(() => createClaudePoolReviewApi(), []);
  const [jobs, setJobs] = useState<SettingsJobDestination>({ kind: 'list' });
  const [persistent, setPersistent] = useState<SettingsPersistentDestination>({ kind: 'list' });
  const workspace = useMemo(() => ({
    category: 'backends' as const,
    wide,
    columns,
    jobs,
    setJobs,
    persistent,
    setPersistent,
    register: () => {},
    changeConnection: (action: () => void) => action(),
    select: () => {},
    guard: (_id: SettingsCategory, action: () => void) => action(),
  }), [wide, columns, jobs, persistent]);
  return <SettingsWorkspaceContext.Provider value={workspace}>
    <SafeAreaView testID="claude-pool-review-safe-area" edges={['top', 'bottom']}
      style={{ flex: 1, backgroundColor: t.colors.background }}>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: t.spacing.xl }}>
        <AIBackendSettingsSection flattened={false} serverUrl="https://review.invalid" mode="single"
          currentNodeId="node-a" nodes={[{ nodeId: 'node-a' }]} loadingNodes={false} apiClient={api} />
      </ScrollView>
    </SafeAreaView>
  </SettingsWorkspaceContext.Provider>;
}
