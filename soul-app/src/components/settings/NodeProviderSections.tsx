import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { useTokens } from '../../theme';
import { GlassButton } from '../GlassSurface';
import { ProviderUsageChart } from '../ProviderUsageChart';
import { SettingsSection } from './SettingsSection';
import { useSettingsWorkspace } from './SettingsWorkspaceContext';
import { createApiClient } from '../../api/client';
import type {
  ProviderName,
  ProviderUsageSnapshot,
} from '../../api/claudeAuthTypes';
import { useAuthStore } from '../../store/authStore';
import { ClaudeProviderSection } from './ClaudeProviderSection';
import { CodexProviderSection } from './CodexProviderSection';

export function NodeProviderSections({
  nodeId,
  serverUrl,
}: {
  nodeId: string;
  serverUrl: string;
}) {
  const t = useTokens();
  const workspace = useSettingsWorkspace();
  const groupStyle = workspace ? { padding: t.cardLayout.padding, gap: t.spacing.md } : undefined;
  const jwt = useAuthStore(state => state.jwt);
  const scopeRevision = useRef(0);
  const requests = useRef<Partial<Record<ProviderName, number>>>({});
  useEffect(() => { ++scopeRevision.current; setUsage(null); setUsageErrors({}); setLoadingProviders({}); return () => { ++scopeRevision.current; }; }, [serverUrl, nodeId, jwt]);
  const [usage, setUsage] = useState<ProviderUsageSnapshot | null>(null);
  const [loadingProviders, setLoadingProviders] = useState<
    Partial<Record<ProviderName, boolean>>
  >({});
  const [usageErrors, setUsageErrors] = useState<
    Partial<Record<ProviderName, string>>
  >({});

  async function refreshUsage(provider: ProviderName) {
    const scope = scopeRevision.current;
    const request = requests.current[provider] = (requests.current[provider] ?? 0) + 1;
    const current = () => scope === scopeRevision.current && request === requests.current[provider];
    setLoadingProviders((current) => ({ ...current, [provider]: true }));
    setUsageErrors((current) => ({ ...current, [provider]: undefined }));
    try {
      const result = await createApiClient(serverUrl).getProviderUsage(nodeId);
      if (current()) setUsage(previous => previous ? { ...result, providers: { ...previous.providers, [provider]: result.providers[provider] } } : result);
    } catch {
      if (!current()) return;
      setUsageErrors((current) => ({
        ...current,
        [provider]: '사용량 조회 중 오류가 발생했습니다. 다시 시도해 주세요.',
      }));
    } finally {
      if (current()) setLoadingProviders((current) => ({ ...current, [provider]: false }));
    }
  }

  const groups = (
    <>
      <View style={groupStyle}><ClaudeProviderSection
        separateUsage={Boolean(workspace)}
        nodeId={nodeId}
        serverUrl={serverUrl}
        usage={usage}
        loadingUsage={Boolean(loadingProviders.claude)}
        usageError={usageErrors.claude ?? null}
        onRefreshUsage={() => void refreshUsage('claude')}
        onTokenDeleted={() => void refreshUsage('claude')}
      /></View>
      {workspace ? <View style={groupStyle}>
        <Text style={{ ...t.foundation.typography.body, color: t.colors.textPrimary, fontWeight: '700' }}>Claude 사용량</Text>
        <GlassButton testID="claude-usage-action" onPress={() => void refreshUsage('claude')} disabled={Boolean(loadingProviders.claude)}>{loadingProviders.claude ? <ActivityIndicator color={t.colors.accent}/> : <Text style={{ ...t.foundation.typography.body, color: t.colors.accent }}>사용량</Text>}</GlassButton>
        {usage ? <ProviderUsageChart usage={usage} providers={['claude']}/> : null}
        {usageErrors.claude ? <Text accessibilityRole="alert" style={{ ...t.foundation.typography.body, color: t.colors.errorText }}>{usageErrors.claude}</Text> : null}
      </View> : null}
      <View style={groupStyle}><CodexProviderSection
        usage={usage}
        loadingUsage={Boolean(loadingProviders.codex)}
        usageError={usageErrors.codex ?? null}
        onRefreshUsage={() => void refreshUsage('codex')}
      /></View>
    </>
  );
  return workspace ? <SettingsSection id="provider-groups" title="AI 연결과 사용량" flattened>{groups.props.children}</SettingsSection> : groups;
}
