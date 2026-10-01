import React from 'react';
import { Text, View } from 'react-native';
import type {
  ProviderName,
  ProviderQuota,
  ProviderUsageSnapshot,
} from '../api/claudeAuthTypes';
import { useTokens } from '../theme';

const PROVIDER_LABELS: Record<ProviderName, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  gemini: 'Gemini',
};

export function formatResetsAt(epochSeconds: number | null): string | null {
  if (!epochSeconds) return null;
  const d = new Date(epochSeconds * 1000);
  const sameDay = d.toDateString() === new Date().toDateString();
  return d.toLocaleString(
    undefined,
    sameDay
      ? { hour: 'numeric', minute: '2-digit' }
      : { month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' },
  );
}

export function quotaAmount(quota: ProviderQuota): string | null {
  if (quota.remaining !== null && quota.limit !== null) {
    return `${quota.remaining.toLocaleString()} / ${quota.limit.toLocaleString()} 남음`;
  }
  if (quota.used !== null && quota.limit !== null) {
    return `${quota.used.toLocaleString()} / ${quota.limit.toLocaleString()} 사용`;
  }
  return null;
}

export function ProviderUsageChart({
  usage,
  providers: visibleProviders,
}: {
  usage: ProviderUsageSnapshot;
  providers?: readonly ProviderName[];
}) {
  const t = useTokens();
  const providers = (Object.entries(usage.providers) as [
    ProviderName,
    ProviderUsageSnapshot['providers'][ProviderName],
  ][]).filter(([provider]) =>
    visibleProviders ? visibleProviders.includes(provider) : true,
  );

  if (providers.length === 0) {
    return (
      <Text
        style={{ color: t.colors.textTertiary, ...t.foundation.typography.meta }}
      >
        사용량 데이터 없음
      </Text>
    );
  }
  const barColor = (u: number) =>
    u >= 80 ? t.colors.error : u >= 50 ? t.colors.warning : t.colors.success;

  return (
    <View style={{ marginTop: t.spacing.sm }}>
      {providers.map(([provider, limits]) => (
        <View
          key={provider}
          testID={`usage-provider-${provider}`}
          style={{ marginVertical: t.spacing.sm }}
        >
          <View
            style={{
              flexDirection: 'row',
              justifyContent: 'space-between',
            }}
          >
            <Text
              style={{
                color: t.colors.textTertiary,
                ...t.foundation.typography.meta,
              }}
            >
              {PROVIDER_LABELS[provider]}
            </Text>
            <Text
              style={{
                color: t.colors.textSecondary,
                ...t.foundation.typography.meta,
              }}
            >
              {limits.status === 'error'
                ? '오류'
                : limits.quotas.length > 0
                  ? limits.planType ?? 'OAuth'
                  : 'OAuth 없음'}
            </Text>
          </View>
          {limits.quotas.length === 0 ? (
            <Text style={{ color: t.colors.textTertiary, ...t.foundation.typography.meta }}>
              {limits.error ?? '조회 가능한 사용량 없음'}
            </Text>
          ) : (
            limits.quotas.map((quota) => {
              const reset = formatResetsAt(quota.resetAt);
              const amount = quotaAmount(quota);
              const used = quota.usedPercent ?? 0;
              return (
                <View
                  key={quota.id}
                  testID={`usage-bar-${quota.id}`}
                  style={{ marginTop: t.spacing.sm }}
                >
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                    <Text
                      style={{
                        color: t.colors.textTertiary,
                        ...t.foundation.typography.meta,
                        flex: 1,
                      }}
                      numberOfLines={1}
                    >
                      {quota.label}
                    </Text>
                    <Text style={{ color: t.colors.textSecondary, ...t.foundation.typography.meta }}>
                      {quota.usedPercent !== null
                        ? `${Math.round(quota.usedPercent)}%`
                        : amount ?? '-'}
                    </Text>
                  </View>
                  {quota.usedPercent !== null && (
                    <View
                      style={{
                        height: 6,
                        backgroundColor: t.colors.surfaceMuted,
                        borderRadius: 3,
                        overflow: 'hidden',
                      }}
                    >
                      <View
                        style={{
                          height: '100%',
                          width: `${used}%`,
                          backgroundColor: barColor(used),
                        }}
                      />
                    </View>
                  )}
                  {(reset || amount) && (
                    <Text style={{ color: t.colors.textTertiary, ...t.foundation.typography.meta }}>
                      {amount ? `${amount}${reset ? ' · ' : ''}` : ''}
                      {reset ? `초기화: ${reset}` : ''}
                    </Text>
                  )}
                </View>
              );
            })
          )}
        </View>
      ))}
    </View>
  );
}
