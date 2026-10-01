import React from 'react';
import { Text, View } from 'react-native';
import { AppGlassPressable } from '../AppGlassCard';
import { useTokens } from '../../theme';

/** Controlled view option; no persistence or card mutation. */
export function CompletedCardsToggle({ includeCompleted, completedCount, onChange }: {
  includeCompleted: boolean; completedCount: number; onChange(value: boolean): void;
}) {
  const t = useTokens();
  return <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: t.spacing.sm }}>
    <AppGlassPressable testID={`completed-cards-toggle-${includeCompleted ? 'on' : 'off'}`} role={includeCompleted ? 'glassDense' : 'glassSoft'}
      accessibilityRole="checkbox" accessibilityLabel="완료 포함" accessibilityState={{ checked: includeCompleted }}
      contentStyle={{ minHeight: t.hitTarget.min, paddingHorizontal: t.spacing.sm, alignItems: 'center', justifyContent: 'center' }}
      onPress={() => onChange(!includeCompleted)}>
      <Text style={{ ...t.foundation.typography.body, color: includeCompleted ? t.colors.textPrimary : t.colors.textSecondary }}>
        {includeCompleted ? '✓ ' : ''}완료 포함
      </Text>
    </AppGlassPressable>
    {!includeCompleted && completedCount > 0 ? <Text style={{ ...t.foundation.typography.meta, color: t.colors.textMuted }}>완료 {completedCount}개 숨김</Text> : null}
  </View>;
}
