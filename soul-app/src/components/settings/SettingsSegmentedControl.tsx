import React, { useMemo, useState } from 'react';
import { Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { createPrimitiveRoles, useTokens, type DesignTokens } from '../../theme';

export interface SettingsSegmentOption<T extends string> {
  value: T;
  label: string;
}

export function SettingsSegmentedControl<T extends string>({
  id,
  value,
  options,
  onChange,
  wrap = false,
}: {
  id: string;
  value: T;
  options: readonly SettingsSegmentOption<T>[];
  onChange(value: T): void;
  wrap?: boolean;
}) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);
  const [focusedValue, setFocusedValue] = useState<T | null>(null);

  return (
    <View style={[styles.track, wrap && styles.wrapTrack]}>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <TouchableOpacity
            key={option.value}
            testID={`settings-segment-${id}-${option.value}`}
            accessibilityRole="button"
            accessibilityLabel={option.label}
            accessibilityState={{ selected }}
            {...(Platform.OS === 'web' ? { 'aria-pressed': selected } : {})}
            style={[styles.hitTarget, wrap && styles.wrapHitTarget]}
            onFocus={() => setFocusedValue(option.value)}
            onBlur={() => setFocusedValue(null)}
            onPress={() => onChange(option.value)}
          >
            <View
              testID={`settings-segment-${id}-${option.value}-visual`}
              pointerEvents="none"
              style={[styles.visual, wrap && styles.wrapVisual, selected && styles.selected]}
            >
              <Text numberOfLines={wrap ? 1 : undefined} style={[styles.label, selected && styles.selectedLabel]}>
                {option.label}
              </Text>
              <View
                testID={`settings-segment-${id}-${option.value}-focus`}
                pointerEvents="none"
                style={[styles.focusRing, focusedValue === option.value && styles.focused]}
              />
            </View>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

function makeStyles(t: DesignTokens) {
  const segment = createPrimitiveRoles(t).segment;
  return StyleSheet.create({
    track: {
      flexDirection: 'row',
      alignItems: 'stretch',
      padding: t.spacing.xxs,
      borderRadius: t.foundation.radius.field,
      backgroundColor: t.colors.surfaceMuted,
    },
    hitTarget: {
      flex: 1,
      minHeight: t.hitTarget.min,
      justifyContent: 'center',
      // Chromium still paints auto outlines at zero width; use a solid style.
      ...(Platform.OS === 'web' ? { outlineStyle: 'solid' as const, outlineWidth: 0 } : {}),
    },
    wrapTrack: { flexWrap: 'wrap' },
    wrapHitTarget: { flex: 0, flexShrink: 0, flexBasis: 'auto' },
    wrapVisual: { width: 'auto' },
    visual: {
      width: '100%',
      minHeight: t.foundation.minHeight.segment,
      paddingHorizontal: t.spacing.xs,
      paddingVertical: t.spacing.xs,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: t.foundation.radius.chip,
    },
    selected: {
      backgroundColor: t.colors.accentTint,
      borderColor: t.colors.accent,
      borderWidth: StyleSheet.hairlineWidth,
    },
    // Overlay the existing visual so focus never changes its padding or size.
    focusRing: {
      ...StyleSheet.absoluteFill,
      borderRadius: segment.radius,
      borderWidth: 2,
      borderColor: 'transparent',
    },
    focused: { borderColor: segment.focusedColor },
    label: {
      ...t.foundation.typography.body,
      color: t.colors.textSecondary,
      textAlign: 'center',
    },
    selectedLabel: {
      color: t.colors.textPrimary,
      fontWeight: '700',
    },
  });
}
