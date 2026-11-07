import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { findUsageSummaryNode } from '../../../../packages/soul-ui/src/lib/usage-summary';
import { createApiClient, type ApiClient } from '../../api/client';
import type {
  AppUsageSummaryNode,
  AppUsageSummaryProvider,
  AppUsageSummarySnapshot,
} from '../../api/usageEndpoints';
import { useAuthStore } from '../../store/authStore';
import { useTokens } from '../../theme';
import { GlassButton } from '../GlassSurface';
import { ClaudeProviderSection, type ClaudeProviderApi } from './ClaudeProviderSection';
import { makeClaudePoolStyles } from './claudeAccountPoolStyles';
import { ProviderQuotaGrid, providerQuotaCells } from './ProviderQuotaGrid';
import { SettingsDivider, SettingsSection } from './SettingsSection';
import { useSettingsWorkspace } from './SettingsWorkspaceContext';

export type NodeProviderSectionsApi = ClaudeProviderApi & Pick<
  ApiClient,
  'getUsageSummary' | 'refreshUsageSummary'
>;

const providerOrder = ['opencode_go', 'codex', 'antigravity'] as const;

const providerLabels: Record<(typeof providerOrder)[number], string> = {
  opencode_go: 'OpenCode Go',
  codex: 'Codex',
  antigravity: 'Antigravity',
};

function nodeUpdatedLabel(node: AppUsageSummaryNode | null, loading: boolean): string | null {
  if (loading) return '갱신 대기 중';
  if (!node) return null;
  const source = node.stale ? node.staleSince ?? node.fetchedAt : node.fetchedAt;
  if (!source) return null;
  const date = new Date(source);
  if (!Number.isFinite(date.getTime())) return null;
  const clock = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
  return node.stale ? `수집 지연 · ${clock}` : `${clock} 갱신`;
}

function ProviderStatusRow({
  provider,
  value,
}: {
  provider: (typeof providerOrder)[number];
  value: AppUsageSummaryProvider;
}) {
  const t = useTokens();
  const styles = useMemo(() => makeClaudePoolStyles(t), [t]);
  const cells = providerQuotaCells(value);
  const dotColor = value.status === 'error' ? t.colors.error
    : value.status === 'not_configured' ? t.colors.textMuted
      : t.colors.success;
  return <View testID={`provider-row-${provider}`} style={styles.accountBlock}>
    <View style={styles.accountHeaderRow}>
      <View style={styles.accountIdentity}>
        <View style={[styles.statusDot, { backgroundColor: dotColor }]} />
        <Text style={styles.providerName}>{providerLabels[provider]}</Text>
        {value.status === 'not_configured' ? <Text style={styles.rowMeta}>미설정</Text> : null}
        {value.status === 'error' ? <Text style={[styles.statusBadge, styles.dangerBadge, { marginLeft: 'auto' }]}>조회 오류</Text> : null}
      </View>
    </View>
    {value.status === 'auto' && cells.some(Boolean)
      ? <ProviderQuotaGrid prefix={`provider-quota-${provider}`} cells={cells} />
      : null}
  </View>;
}

export function NodeProviderSections({
  nodeId,
  serverUrl,
  apiClient,
}: {
  nodeId: string;
  serverUrl: string;
  apiClient?: NodeProviderSectionsApi;
}) {
  const t = useTokens();
  const workspace = useSettingsWorkspace();
  const styles = useMemo(() => makeClaudePoolStyles(t), [t]);
  const api = useMemo(() => apiClient ?? createApiClient(serverUrl), [apiClient, serverUrl]);
  const jwt = useAuthStore(state => state.jwt);
  const revision = useRef(0);
  const [summary, setSummary] = useState<AppUsageSummarySnapshot | null>(null);
  const [loadingSummary, setLoadingSummary] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [claudeReloadKey, setClaudeReloadKey] = useState(0);

  useEffect(() => {
    const request = ++revision.current;
    setSummary(null);
    setLoadingSummary(true);
    setRefreshing(false);
    setRefreshFailed(false);
    if (!nodeId) {
      setLoadingSummary(false);
      return;
    }
    void api.getUsageSummary().then(result => {
      if (request !== revision.current) return;
      setSummary(result);
      setLoadingSummary(false);
    }).catch(() => {
      if (request === revision.current) setLoadingSummary(false);
    });
    return () => { ++revision.current; };
  }, [api, nodeId, jwt]);

  async function refreshSummary() {
    if (refreshing) return;
    const scope = revision.current;
    setRefreshing(true);
    setRefreshFailed(false);
    try {
      const result = await api.refreshUsageSummary();
      if (scope !== revision.current) return;
      setSummary(result);
      setClaudeReloadKey(value => value + 1);
    } catch {
      if (scope === revision.current) setRefreshFailed(true);
    } finally {
      if (scope === revision.current) setRefreshing(false);
    }
  }

  async function reloadAfterTokenChange() {
    const scope = revision.current;
    setClaudeReloadKey(value => value + 1);
    try {
      const result = await api.getUsageSummary();
      if (scope === revision.current) setSummary(result);
    } catch { /* the previous gauges stay visible */ }
  }

  const node = findUsageSummaryNode(summary, nodeId) as AppUsageSummaryNode | null;
  const updated = nodeUpdatedLabel(node, loadingSummary);
  const rows: React.ReactNode[] = [<ClaudeProviderSection
    key="claude"
    nodeId={nodeId}
    api={api}
    summaryProvider={node?.providers.claude ?? null}
    loadingSummary={loadingSummary}
    reloadKey={claudeReloadKey}
    onTokenDeleted={() => void reloadAfterTokenChange()}
  />];
  for (const provider of providerOrder) {
    const value = node?.providers[provider];
    if (value) rows.push(<ProviderStatusRow key={provider} provider={provider} value={value} />);
  }
  const separated = rows.flatMap((row, index) => index === 0
    ? [row]
    : [<SettingsDivider key={`divider-${index}`} />, row]);

  const content = <View testID="provider-panel" style={styles.accountList}>
    <View style={styles.listHeaderRow}>
      {updated ? <Text testID="provider-panel-updated" style={node?.stale ? styles.blockedBadge : styles.metaText}>{updated}</Text> : null}
      {refreshFailed ? <Text testID="provider-panel-refresh-error" style={styles.refreshFailureText}>새로고침 실패</Text> : null}
      <GlassButton
        testID="provider-panel-refresh"
        iconOnly
        size="compact"
        borderRadius={t.foundation.radius.round}
        accessibilityLabel="사용량 새로고침"
        onPress={() => void refreshSummary()}
        disabled={refreshing}
      >
        {refreshing
          ? <ActivityIndicator size="small" color={t.colors.accent} />
          : <Ionicons name="refresh" size={t.iconSize.compact} color={t.colors.textSecondary} />}
      </GlassButton>
    </View>
    {separated}
  </View>;

  return workspace
    ? <SettingsSection id="provider-groups" title="AI 연결과 사용량" flattened>{content}</SettingsSection>
    : content;
}
