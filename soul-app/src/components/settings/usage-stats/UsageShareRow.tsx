import React from 'react';
import { Text, View } from 'react-native';
import { CompactTouchTarget } from '../../CompactTouchTarget';
import { useTokens } from '../../../theme';

export function UsageShareRow({
  label,
  value,
  share,
  color,
  testID,
  valueTestID,
  onPress,
}: {
  label: string;
  value: string;
  share: number | null;
  color: string;
  testID?: string;
  valueTestID?: string;
  onPress?: () => void;
}) {
  const t = useTokens();
  const boundedShare = share === null ? null : Math.min(1, Math.max(0, share));
  const shareLabel = boundedShare === null ? null : `${Math.round(boundedShare * 100)}%`;
  return (
    <CompactTouchTarget
      testID={testID}
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={onPress ? [label, value, shareLabel].filter(Boolean).join(', ') : undefined}
      onPress={onPress}
      accessible={Boolean(onPress)}
      frameStyle={{ width: '100%' }}
      surfaceStyle={{ width: '100%', alignItems: 'stretch', gap: t.spacing.xxs }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm }}>
        <Text numberOfLines={1} style={{ flex: 1, ...t.foundation.typography.body, color: t.colors.textPrimary }}>{label}</Text>
        <Text testID={valueTestID ?? (testID ? `${testID}-value` : undefined)} style={{ ...t.foundation.typography.body, color: t.colors.textSecondary, fontVariant: ['tabular-nums'] }}>{value}</Text>
        {shareLabel ? <Text style={{ ...t.foundation.typography.meta, color: t.colors.textSecondary, fontVariant: ['tabular-nums'] }}>{shareLabel}</Text> : null}
      </View>
      <View accessibilityElementsHidden importantForAccessibility="no" style={{ height: t.spacing.xs, borderRadius: t.radius.sm, backgroundColor: t.persistentSession.line, overflow: 'hidden' }}>
        {boundedShare !== null ? <View style={{ height: '100%', width: `${boundedShare * 100}%`, backgroundColor: color }} /> : null}
      </View>
    </CompactTouchTarget>
  );
}
