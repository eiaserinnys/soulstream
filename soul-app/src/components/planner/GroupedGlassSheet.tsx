import React, { Children, Fragment, useMemo } from 'react';
import {
  Pressable,
  StyleSheet,
  View,
  type AccessibilityState,
  type AccessibilityRole,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { createPlannerVisualRoles, useTokens, type DesignTokens } from '../../theme';
import { CompactTouchTarget } from '../CompactTouchTarget';
import { AppGlassCard } from '../AppGlassCard';

export function GroupedGlassSheet({
  children,
  style,
  testID,
  surface = 'glass',
}: {
  children?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  surface?: 'glass' | 'inherited';
}) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);
  const rows = Children.toArray(children);
  const content = rows.map((row, index) => (
    <Fragment key={(row as React.ReactElement).key ?? index}>
      {index > 0 ? <View testID="grouped-glass-divider" style={styles.divider} /> : null}
      {row}
    </Fragment>
  ));
  if (surface === 'inherited') {
    return <View testID={testID} style={[styles.sheet, style]}>{content}</View>;
  }
  return (
    <AppGlassCard role="glassCard" testID={testID} style={[styles.sheet, style]}>
      {content}
    </AppGlassCard>
  );
}

export function GroupedGlassRow({
  children,
  compact = false,
  style,
  testID,
  disabled,
  selected = false,
  accessibilityLabel,
  accessibilityRole = 'button',
  accessibilityState,
  testOnlyPressed,
  hitSlop,
  onPress,
  onLongPress,
}: {
  children?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  compact?: boolean;
  disabled?: boolean;
  selected?: boolean;
  accessibilityLabel?: string;
  accessibilityRole?: AccessibilityRole;
  accessibilityState?: AccessibilityState;
  testOnlyPressed?: boolean;
  hitSlop?: number;
  onPress?: () => void;
  onLongPress?: () => void;
}) {
  const t = useTokens();
  const planner = useMemo(() => createPlannerVisualRoles(t), [t]);
  const styles = useMemo(() => makeStyles(t), [t]);
  const interactive = !disabled && !!(onPress || onLongPress);
  if (compact) return <CompactTouchTarget testID={testID} disabled={!interactive} accessibilityRole={accessibilityRole}
    accessibilityLabel={accessibilityLabel} accessibilityState={{ ...accessibilityState, disabled: !interactive, selected }}
    onPress={onPress} onLongPress={onLongPress} frameStyle={{ alignSelf: 'stretch' }}
    surfaceTestID={testID ? `${testID}-visual` : undefined}
    surfaceStyle={[style, styles.compactRow, { backgroundColor: selected ? t.colors.accentTint : 'transparent' }]}>{children}</CompactTouchTarget>;
  return (
    <Pressable
      testID={testID}
      disabled={!interactive}
      accessibilityRole={interactive ? accessibilityRole : undefined}
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ ...accessibilityState, disabled: !interactive, selected }}
      testOnly_pressed={testOnlyPressed}
      hitSlop={hitSlop}
      onPress={onPress}
      onLongPress={onLongPress}
      style={({ pressed }) => [
        styles.rowTouchTarget,
        {
          backgroundColor: resolveGroupedRowBackground({
            selected,
            pressed,
            interactive,
            selectedColor: t.colors.accentTint,
            pressedColor: planner.grouped.pressedColor,
          }),
        },
        style,
      ]}
    >
      {children}
    </Pressable>
  );
}

export function resolveGroupedRowBackground(input: {
  selected: boolean;
  pressed: boolean;
  interactive: boolean;
  selectedColor: string;
  pressedColor: string;
}): string {
  if (input.selected) return input.selectedColor;
  if (input.pressed && input.interactive) return input.pressedColor;
  return 'transparent';
}

function makeStyles(t: DesignTokens) {
  const planner = createPlannerVisualRoles(t);
  return StyleSheet.create({
    sheet: { overflow: 'hidden' },
    divider: {
      height: StyleSheet.hairlineWidth,
      marginLeft: t.cardLayout.padding,
      backgroundColor: planner.grouped.dividerColor,
    },
    compactRow: { height: t.foundation.iconFrame.compact, width: '100%', justifyContent: 'center', paddingVertical: 0 },
    rowTouchTarget: {
      minWidth: t.hitTarget.min,
      minHeight: t.hitTarget.min,
    },
  });
}
