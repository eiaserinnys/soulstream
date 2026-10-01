import React, { useMemo } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useTokens, type DesignTokens } from '../../theme';

export interface SettingsSegmentOption<T extends string> {
  value: T;
  label: string;
}

export function SettingsSegmentedControl<T extends string>({
  id,
  value,
  options,
  onChange,
}: {
  id: string;
  value: T;
  options: readonly SettingsSegmentOption<T>[];
  onChange(value: T): void;
}) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);

  return (
    <View style={styles.track}>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <TouchableOpacity
            key={option.value}
            testID={`settings-segment-${id}-${option.value}`}
            accessibilityRole="button"
            accessibilityLabel={option.label}
            accessibilityState={{ selected }}
            style={styles.hitTarget}
            onPress={() => onChange(option.value)}
          >
            <View
              testID={`settings-segment-${id}-${option.value}-visual`}
              pointerEvents="none"
              style={[styles.visual, selected && styles.selected]}
            >
              <Text style={[styles.label, selected && styles.selectedLabel]}>
                {option.label}
              </Text>
            </View>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

function makeStyles(t: DesignTokens) {
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
    },
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
