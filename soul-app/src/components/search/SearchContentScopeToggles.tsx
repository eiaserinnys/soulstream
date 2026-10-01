import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { SearchFilters } from '../../store/searchStore';
import { useTokens, type DesignTokens } from '../../theme';
import { AppGlassPressable } from '../AppGlassCard';

type ContentScopeKey =
  | 'includeTurnSummaries'
  | 'includeHighlight'
  | 'includeStory';

const OPTIONS: ReadonlyArray<readonly [ContentScopeKey, string]> = [
  ['includeTurnSummaries', '턴 요약'],
  ['includeHighlight', '하이라이트'],
  ['includeStory', '줄거리'],
];

type Props = Pick<
  SearchFilters,
  'includeTurnSummaries' | 'includeHighlight' | 'includeStory'
> & {
  onChange(filters: Partial<SearchFilters>): void;
};

export function SearchContentScopeToggles({
  includeTurnSummaries,
  includeHighlight,
  includeStory,
  onChange,
}: Props) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);
  const values = { includeTurnSummaries, includeHighlight, includeStory };

  return (
    <View style={styles.container}>
      <Text style={styles.label}>포함 범위</Text>
      <View style={styles.options}>
        {OPTIONS.map(([key, label]) => {
          const active = values[key];
          return (
            <AppGlassPressable
              key={key}
              role={active ? 'glassDense' : 'glassSoft'}
              style={[styles.toggle, active && styles.toggleActive]}
              contentStyle={styles.toggleContent}
              accessibilityLabel={`${label} 포함`}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: active }}
              onPress={() => onChange({ [key]: !active })}
            >
              <Text style={[styles.toggleText, active && styles.toggleTextActive]}>
                {label}
              </Text>
            </AppGlassPressable>
          );
        })}
      </View>
    </View>
  );
}

function makeStyles(t: DesignTokens) {
  return StyleSheet.create({
    container: {
      gap: t.spacing.xs,
    },
    label: {
      color: t.colors.textTertiary,
      ...t.foundation.typography.label,
    },
    options: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: t.spacing.sm,
    },
    toggle: {
      flexGrow: 1,
      flexBasis: 0,
      minWidth: 92,
    },
    toggleActive: {
      borderWidth: 1,
      borderColor: t.colors.accent,
    },
    toggleContent: {
      minHeight: t.hitTarget.min,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: t.spacing.sm,
    },
    toggleText: {
      color: t.colors.textSecondary,
      ...t.foundation.typography.label,
    },
    toggleTextActive: {
      color: t.colors.textPrimary,
      fontWeight: '600',
    },
  });
}
