import React from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { LiquidGlassButton } from '../LiquidGlassButton';
import { useTokens } from '../../theme';

/** Controlled view option; no persistence or card mutation. */
export function CompletedCardsToggle({ includeCompleted, onChange }: {
  includeCompleted: boolean; completedCount?: number; onChange(value: boolean): void;
}) {
  const t = useTokens();
  const hideCompleted = !includeCompleted;
  return <LiquidGlassButton iconOnly borderRadius={t.foundation.radius.round}
    testID={`completed-cards-toggle-${hideCompleted ? 'on' : 'off'}`}
    accessibilityLabel="완료 숨김" accessibilityState={{ selected: hideCompleted }} aria-pressed={hideCompleted}
    onPress={() => onChange(!includeCompleted)}>
    <Ionicons name={hideCompleted ? 'eye-off-outline' : 'eye-outline'} size={t.iconSize.standard}
      color={hideCompleted ? t.colors.accent : t.colors.textPrimary} />
  </LiquidGlassButton>;
}
