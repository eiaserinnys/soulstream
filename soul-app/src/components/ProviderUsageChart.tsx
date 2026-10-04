import React from 'react';
import { Text, View } from 'react-native';
import type {
  ProviderName,
  ProviderQuota,
  ProviderUsageSnapshot,
} from '../api/claudeAuthTypes';
import { safeErrorDetail } from '../../../packages/soul-ui/src/lib/safe-error-detail';
import { useTokens } from '../theme';

const PROVIDER_LABELS: Record<ProviderName, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  gemini: 'Gemini',
};

export function formatResetsAt(epochSeconds: number | null): string | null {
  if (epochSeconds === null) return null;
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
    return `${quota.remaining.toLocaleString(undefined, { maximumFractionDigits: 20 })} / ${quota.limit.toLocaleString(undefined, { maximumFractionDigits: 20 })} 남음`;
  }
  if (quota.used !== null && quota.limit !== null) {
    return `${quota.used.toLocaleString(undefined, { maximumFractionDigits: 20 })} / ${quota.limit.toLocaleString(undefined, { maximumFractionDigits: 20 })} 사용`;
  }
  if (quota.remaining !== null) return `${quota.remaining.toLocaleString(undefined, { maximumFractionDigits: 20 })} 남음`;
  if (quota.used !== null) return `${quota.used.toLocaleString(undefined, { maximumFractionDigits: 20 })} 사용`;
  if (quota.remainingPercent !== null) return `${quota.remainingPercent}% 남음`;
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
        style={{ color: t.colors.textTertiary, ...t.foundation.typography.body }}
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
              flexWrap: 'wrap',
              gap: t.spacing.xs,
            }}
          >
            <Text
              style={{
                color: t.colors.textTertiary,
                ...t.foundation.typography.body,
              }}
            >
              {PROVIDER_LABELS[provider]}
            </Text>
            <Text
              style={{
                color: t.colors.textSecondary,
                ...t.foundation.typography.body,
              }}
            >
              {limits.status === 'error'
                ? '오류'
                : limits.status === 'not_configured'
                  ? 'OAuth 없음'
                  : limits.planType ?? '조회됨'}
            </Text>
          </View>
          {limits.quotas.length === 0 ? (
            <Text style={{ color: t.colors.textTertiary, ...t.foundation.typography.body }}>
              {limits.error ? safeErrorDetail(limits.error) : '조회 가능한 사용량 없음'}
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
                  accessible accessibilityLabel={[quota.label, quota.usedPercent !== null ? `${quota.usedPercent}%` : null, amount, reset ? `초기화: ${reset}` : null].filter(Boolean).join(' · ')}
                  style={{ marginTop: t.spacing.sm }}
                >
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                    <Text
                      style={{
                        color: t.colors.textTertiary,
                        ...t.foundation.typography.body,
                        flex: 1,
                      }}
                      numberOfLines={1}
                    >
                      {quota.label}
                    </Text>
                    <Text style={{ color: t.colors.textSecondary, ...t.foundation.typography.body }}>
                      {quota.usedPercent !== null
                        ? `${quota.usedPercent}%`
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
                        testID={`usage-fill-${quota.id}`}
                        style={{
                          height: '100%',
                          width: `${Math.max(0, Math.min(100, used))}%`,
                          backgroundColor: barColor(used),
                        }}
                      />
                    </View>
                  )}
                  {(reset || amount) && (
                    <Text style={{ color: t.colors.textTertiary, ...t.foundation.typography.body }}>
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
