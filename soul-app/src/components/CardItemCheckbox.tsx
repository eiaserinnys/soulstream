import React from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { CompactTouchTarget } from './CompactTouchTarget';
import { useTokens } from '../theme';

export function CardItemCheckbox({
  itemId,
  title,
  checked,
  disabled = false,
  onPress,
}: {
  itemId: number;
  title: string;
  checked: boolean;
  disabled?: boolean;
  onPress(): void;
}) {
  const t = useTokens();
  const label = `${itemId} ${title} ${checked ? '확인 해제' : '확인'}`;
  const square = {
    width: t.iconSize.prominent,
    height: t.iconSize.prominent,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: checked ? t.colors.statusCompleted : t.colors.textPlaceholder,
    backgroundColor: checked ? t.colors.statusCompleted : 'transparent',
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    opacity: disabled ? 0.55 : 1,
  };

  return (
    <CompactTouchTarget
      testID={`card-item-checkbox-${itemId}`}
      accessibilityRole="checkbox"
      accessibilityLabel={label}
      accessibilityState={{ checked, disabled }}
      disabled={disabled}
      onPress={onPress}
      frameStyle={{ flexShrink: 0 }}
      surfaceStyle={square}
    >
      {checked ? <Ionicons testID={`card-item-checkbox-${itemId}-checkmark`} name="checkmark" size={t.foundation.typography.label.fontSize} color={t.colors.accentText} /> : null}
    </CompactTouchTarget>
  );
}
