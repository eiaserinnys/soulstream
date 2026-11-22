import { useMemo, useState } from 'react';
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
  const state = typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('state');
  const api = useMemo(() => createClaudePoolReviewApi(state), [state]);
  // 중앙 풀 장면에서만 오케스트레이터 화면(중앙 구역 + 조회 노드 고르기)을 그린다.
  const centralScene = (state ?? '').startsWith('central');
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
        <AIBackendSettingsSection flattened={false} serverUrl="https://review.invalid"
          mode={centralScene ? 'orchestrator' : 'single'}
          currentNodeId="node-a"
          nodes={centralScene ? [{ nodeId: 'node-a' }, { nodeId: 'node-b' }] : [{ nodeId: 'node-a' }]}
          loadingNodes={false} apiClient={api} />
      </ScrollView>
    </SafeAreaView>
  </SettingsWorkspaceContext.Provider>;
}
