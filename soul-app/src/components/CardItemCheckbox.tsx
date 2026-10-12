import React from 'react';
import { Platform } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { CompactTouchTarget } from './CompactTouchTarget';
import { useTokens } from '../theme';

type CardItemCheckboxBaseProps = {
  title: string;
  checked: boolean;
  disabled?: boolean;
  onPress(): void;
};

type CardItemCheckboxProps = CardItemCheckboxBaseProps & (
  | { variant: 'chat'; testID?: string }
  | { variant?: undefined; itemId: number }
);

export function CardItemCheckbox(props: CardItemCheckboxProps) {
  const { title, checked, disabled = false, onPress } = props;
  const chat = props.variant === 'chat';
  const itemId = props.variant === 'chat' ? undefined : props.itemId;
  const testID = props.variant === 'chat' ? props.testID : `card-item-checkbox-${itemId}`;
  const t = useTokens();
  const [focused, setFocused] = React.useState(false);
  const label = props.variant === 'chat' ? title : `${itemId} ${title} ${checked ? '확인 해제' : '확인'}`;
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
  const chatWebProps = chat && Platform.OS === 'web' ? {
    'aria-checked': checked,
    onKeyDownCapture: (event: { key: string; preventDefault(): void; stopPropagation(): void }) => {
      if (event.key === ' ' && !disabled) {
        event.preventDefault();
        event.stopPropagation();
        onPress();
      }
    },
  } : {};

  return (
    <CompactTouchTarget
      {...(chatWebProps as any)}
      testID={testID}
      accessibilityRole="checkbox"
      accessibilityLabel={label}
      accessibilityState={{ checked, disabled }}
      disabled={disabled}
      onPress={onPress}
      {...(chat ? { onFocus: () => setFocused(true), onBlur: () => setFocused(false) } : {})}
      frameStyle={chat && Platform.OS === 'web' ? { flexShrink: 0, outlineStyle: 'solid', outlineWidth: 0 } : { flexShrink: 0 }}
      surfaceTestID={chat && testID ? `${testID}-visual` : undefined}
      surfaceStyle={chat ? [square, focused ? { borderColor: t.colors.accent } : undefined] : square}
    >
      {checked ? <Ionicons testID={testID ? `${testID}-checkmark` : undefined} name="checkmark" size={t.foundation.typography.label.fontSize} color={t.colors.accentText} /> : null}
    </CompactTouchTarget>
  );
}
