import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { AppGlassPressable } from '../AppGlassCard';
import type { SearchScope } from '../../store/searchStore';
import { useTokens, type DesignTokens } from '../../theme';

const OPTIONS: Array<{ value: SearchScope; label: string }> = [
  { value: 'all', label: '전체' },
  { value: 'sessions', label: '세션' },
  { value: 'messages', label: '대화내용' },
];

export function SearchScopeSegment({
  value,
  onChange,
}: {
  value: SearchScope;
  onChange(value: SearchScope): void;
}) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);
  return (
    <View
      style={styles.container}
      accessibilityRole="tablist"
      accessibilityLabel="검색 범위"
    >
      {OPTIONS.map((option) => {
        const active = option.value === value;
        return (
          <AppGlassPressable
            key={option.value}
            role={active ? 'glassDense' : 'glassSoft'}
            style={[styles.option, active && styles.active]}
            contentStyle={styles.optionContent}
            accessibilityRole="tab"
            accessibilityLabel={`${option.label} 검색`}
            onPress={() => onChange(option.value)}
          >
            <Text style={[styles.label, active && styles.activeLabel]}>
              {option.label}
            </Text>
          </AppGlassPressable>
        );
      })}
    </View>
  );
}

function makeStyles(t: DesignTokens) {
  return StyleSheet.create({
    container: {
      flexDirection: 'row',
      gap: t.spacing.xs,
    },
    option: {
      flex: 1,
      minWidth: 0,
    },
    active: {
      borderWidth: 1,
      borderColor: t.colors.accent,
    },
    optionContent: {
      minHeight: t.foundation.minHeight.segment,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: t.spacing.sm,
    },
    label: {
      color: t.colors.textSecondary,
      ...t.foundation.typography.label,
    },
    activeLabel: {
      color: t.colors.textPrimary,
    },
  });
}
