import React from 'react';
import { Text, View } from 'react-native';
import { CompactTouchTarget } from '../../CompactTouchTarget';
import { createPrimitiveRoles, useTokens } from '../../../theme';

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
  const content = (
    <>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm }}>
        <Text numberOfLines={1} style={{ flex: 1, ...t.foundation.typography.body, color: t.colors.textPrimary }}>{label}</Text>
        <Text testID={valueTestID ?? (testID ? `${testID}-value` : undefined)} style={{ ...t.foundation.typography.body, color: t.colors.textSecondary, fontVariant: ['tabular-nums'] }}>{value}</Text>
        {shareLabel ? <Text style={{ ...t.foundation.typography.meta, color: t.colors.textSecondary, fontVariant: ['tabular-nums'] }}>{shareLabel}</Text> : null}
      </View>
      {boundedShare !== null ? <View testID={testID ? `${testID}-track` : undefined} accessibilityElementsHidden importantForAccessibility="no" style={{ height: t.spacing.xs, borderRadius: t.radius.sm, backgroundColor: t.persistentSession.line, overflow: 'hidden' }}>
        {boundedShare !== null ? <View style={{ height: '100%', width: `${boundedShare * 100}%`, backgroundColor: color }} /> : null}
      </View> : null}
    </>
  );

  if (onPress) {
    return (
      <CompactTouchTarget
        testID={testID}
        accessibilityRole="button"
        accessibilityLabel={[label, value, shareLabel].filter(Boolean).join(', ')}
        onPress={onPress}
        accessible
        frameStyle={{ width: '100%' }}
        surfaceStyle={{ width: '100%', alignItems: 'stretch', gap: t.spacing.xxs }}
      >
        {content}
      </CompactTouchTarget>
    );
  }

  const frameMinimum = Math.max(t.hitTarget.min, createPrimitiveRoles(t).iconFrame.minHeight);
  return (
    <View
      testID={testID}
      style={{
        width: '100%',
        minWidth: frameMinimum,
        minHeight: frameMinimum,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <View style={{ width: '100%', alignItems: 'stretch', gap: t.spacing.xxs }}>
        {content}
      </View>
    </View>
  );
}
