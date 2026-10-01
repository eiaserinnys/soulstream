import React, { useState } from 'react';
import { createApiClient } from '../../api/client';
import type {
  ProviderName,
  ProviderUsageSnapshot,
} from '../../api/claudeAuthTypes';
import { ClaudeProviderSection } from './ClaudeProviderSection';
import { CodexProviderSection } from './CodexProviderSection';

export function NodeProviderSections({
  nodeId,
  serverUrl,
}: {
  nodeId: string;
  serverUrl: string;
}) {
  const [usage, setUsage] = useState<ProviderUsageSnapshot | null>(null);
  const [loadingProviders, setLoadingProviders] = useState<
    Partial<Record<ProviderName, boolean>>
  >({});
  const [usageErrors, setUsageErrors] = useState<
    Partial<Record<ProviderName, string>>
  >({});

  async function refreshUsage(provider: ProviderName) {
    setLoadingProviders((current) => ({ ...current, [provider]: true }));
    setUsageErrors((current) => ({ ...current, [provider]: undefined }));
    try {
      setUsage(await createApiClient(serverUrl).getProviderUsage(nodeId));
    } catch (error: any) {
      setUsageErrors((current) => ({
        ...current,
        [provider]: error?.message ?? '사용량 조회 중 오류가 발생했습니다.',
      }));
    } finally {
      setLoadingProviders((current) => ({ ...current, [provider]: false }));
    }
  }

  return (
    <>
      <ClaudeProviderSection
        nodeId={nodeId}
        serverUrl={serverUrl}
        usage={usage}
        loadingUsage={Boolean(loadingProviders.claude)}
        usageError={usageErrors.claude ?? null}
        onRefreshUsage={() => void refreshUsage('claude')}
        onTokenDeleted={() => void refreshUsage('claude')}
      />
      <CodexProviderSection
        usage={usage}
        loadingUsage={Boolean(loadingProviders.codex)}
        usageError={usageErrors.codex ?? null}
        onRefreshUsage={() => void refreshUsage('codex')}
      />
    </>
  );
}
