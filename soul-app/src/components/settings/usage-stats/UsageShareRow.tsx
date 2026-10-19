import React from 'react';
import { Text, View } from 'react-native';
import { useTokens } from '../../../theme';

export function UsageShareRow({
  label,
  value,
  share,
  color,
  testID,
  valueTestID,
}: {
  label: string;
  value: string;
  share: number | null;
  color: string;
  testID?: string;
  valueTestID?: string;
}) {
  const t = useTokens();
  const boundedShare = share === null ? null : Math.min(1, Math.max(0, share));
  return (
    <View testID={testID} style={{ gap: t.spacing.xxs }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm }}>
        <View style={{ width: t.spacing.sm, height: t.spacing.sm, borderRadius: t.radius.sm, backgroundColor: color }} />
        <Text numberOfLines={1} style={{ flex: 1, ...t.foundation.typography.body, color: t.colors.textPrimary }}>{label}</Text>
        <Text testID={valueTestID ?? (testID ? `${testID}-value` : undefined)} style={{ ...t.foundation.typography.body, color: t.colors.textSecondary, fontVariant: ['tabular-nums'] }}>{value}</Text>
      </View>
      <View accessibilityElementsHidden importantForAccessibility="no" style={{ height: t.spacing.xs, borderRadius: t.radius.sm, backgroundColor: t.persistentSession.line, overflow: 'hidden' }}>
        {boundedShare !== null ? <View style={{ height: '100%', width: `${boundedShare * 100}%`, backgroundColor: color }} /> : null}
      </View>
    </View>
  );
}
