import Ionicons from '@expo/vector-icons/Ionicons';
import React, { useMemo } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useTokens, type DesignTokens } from '../../theme';
import {
  SETTINGS_CATEGORIES,
  type SettingsCategory,
} from './settingsCategories';

export function SettingsCategorySidebar({
  selected,
  onSelect,
  showAdmin = false,
}: {
  selected: SettingsCategory;
  onSelect(value: SettingsCategory): void;
  showAdmin?: boolean;
}) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);

  return (
    <View testID="settings-category-sidebar" style={styles.sidebar}>
      {SETTINGS_CATEGORIES
        .filter((category) => category.id !== 'review-policy' || showAdmin)
        .map((category) => {
          const active = category.id === selected;
          return (
            <TouchableOpacity
              key={category.id}
              testID={`settings-category-${category.id}`}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              style={[styles.row, active && styles.activeRow]}
              onPress={() => onSelect(category.id)}
            >
              <Ionicons
                name={category.icon}
                size={t.iconSize.standard}
                color={active ? t.colors.accent : t.colors.textSecondary}
              />
              <Text style={[styles.label, active && styles.activeLabel]}>
                {category.label}
              </Text>
              {active ? (
                <Ionicons
                  name="chevron-forward"
                  size={t.iconSize.compact}
                  color={t.colors.accent}
                />
              ) : null}
            </TouchableOpacity>
          );
        })}
    </View>
  );
}

function makeStyles(t: DesignTokens) {
  return StyleSheet.create({
    sidebar: {
      width: 240,
      padding: t.spacing.md,
      gap: t.spacing.xs,
      borderRightWidth: StyleSheet.hairlineWidth,
      borderRightColor: t.colors.border,
      backgroundColor: t.colors.surfaceMuted,
    },
    row: {
      width: '100%',
      minHeight: t.hitTarget.min,
      paddingHorizontal: t.spacing.md,
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.spacing.sm,
      borderRadius: t.foundation.radius.field,
    },
    activeRow: {
      backgroundColor: t.colors.accentTint,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.colors.accent,
    },
    label: {
      ...t.foundation.typography.body,
      color: t.colors.textSecondary,
      flex: 1,
    },
    activeLabel: {
      color: t.colors.textPrimary,
      fontWeight: '700',
    },
  });
}
