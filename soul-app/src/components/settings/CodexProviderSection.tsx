import React, { useMemo } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import type { ProviderUsageSnapshot } from '../../api/claudeAuthTypes';
import { useTokens, type DesignTokens } from '../../theme';
import { GlassButton } from '../GlassSurface';
import { useSettingsWorkspace } from './SettingsWorkspaceContext';
import { ProviderUsageChart } from '../ProviderUsageChart';

export function CodexProviderSection({
  usage,
  loadingUsage,
  usageError,
  onRefreshUsage,
}: {
  usage: ProviderUsageSnapshot | null;
  loadingUsage: boolean;
  usageError: string | null;
  onRefreshUsage(): void;
}) {
  const workspace = useSettingsWorkspace();
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);

  return (
    <View testID="backend-provider-codex" style={[styles.provider, workspace && { paddingTop: 0, marginTop: 0, borderTopWidth: 0 }]}>
      <View style={styles.headingRow}>
        <Text style={styles.title}>Codex</Text>
        <GlassButton
          testID="backend-provider-codex-usage-action"
          surfaceTestID="backend-provider-codex-usage-action-surface"
          style={styles.action}
          contentStyle={styles.buttonContent}
          disabled={loadingUsage}
          onPress={onRefreshUsage}
        >
          {loadingUsage ? (
            <ActivityIndicator size="small" color={t.colors.accent} />
          ) : (
            <Text style={styles.actionText}>사용량</Text>
          )}
        </GlassButton>
      </View>
      {usage ? <ProviderUsageChart usage={usage} providers={['codex']} /> : null}
      {usageError ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {usageError}
        </Text>
      ) : null}
    </View>
  );
}

function makeStyles(t: DesignTokens) {
  return StyleSheet.create({
    provider: {
      paddingTop: t.spacing.lg,
      marginTop: t.spacing.lg,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: t.colors.border,
      gap: t.spacing.md,
    },
    headingRow: {
      flexDirection: 'row',
      alignItems: 'center',
      flexWrap: 'wrap',
      gap: t.spacing.md,
    },
    title: {
      ...t.foundation.typography.body,
      color: t.colors.textPrimary,
      fontWeight: '700',
      flex: 1,
    },
    action: { minWidth: 120 },
    buttonContent: { minHeight: t.foundation.minHeight.secondary },
    actionText: {
      ...t.foundation.typography.body,
      color: t.colors.link,
      fontWeight: '600',
    },
    error: {
      ...t.foundation.typography.body,
      color: t.colors.errorText,
    },
  });
}
