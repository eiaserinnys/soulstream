import React, { useMemo } from 'react';
import { ScrollView, StyleSheet, Text } from 'react-native';
import type { Folder } from '../../api/types';
import {
  DEFAULT_SEARCH_FILTERS,
  type SearchFilters,
} from '../../store/searchStore';
import { useTokens, type DesignTokens } from '../../theme';
import { AppGlassPressable } from '../AppGlassCard';

export function SearchFilterChips({
  filters,
  folders,
  onChange,
}: {
  filters: SearchFilters;
  folders: Folder[];
  onChange(filters: Partial<SearchFilters>): void;
}) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);
  const folder = folders.find((item) => item.id === filters.folderId);
  const chips = [
    folder
      ? { key: 'folder', label: `폴더 · ${folder.name}`, clear: () => onChange({ folderId: null }) }
      : null,
    filters.nodeId
      ? { key: 'node', label: `노드 · ${filters.nodeId}`, clear: () => onChange({ nodeId: null }) }
      : null,
    filters.statuses.length
      ? { key: 'status', label: `상태 ${filters.statuses.length}`, clear: () => onChange({ statuses: [] }) }
      : null,
    filters.backends.length
      ? { key: 'backend', label: `백엔드 ${filters.backends.length}`, clear: () => onChange({ backends: [] }) }
      : null,
    filters.period !== 'all'
      ? { key: 'period', label: `기간 · ${filters.period}`, clear: () => onChange({ period: 'all' }) }
      : null,
    !sameValues(
      filters.eventCategories,
      DEFAULT_SEARCH_FILTERS.eventCategories,
    )
      ? {
          key: 'events',
          label: `발화 ${filters.eventCategories.length}`,
          clear: () => onChange({
            eventCategories: [...DEFAULT_SEARCH_FILTERS.eventCategories],
          }),
        }
      : null,
  ].filter((chip): chip is NonNullable<typeof chip> => chip !== null);
  if (chips.length === 0) return null;
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={styles.row}
    >
      {chips.map((chip) => (
        <AppGlassPressable
          key={chip.key}
          contentStyle={styles.chip}
          accessibilityLabel={`${chip.label} 필터 해제`}
          onPress={chip.clear}
        >
          <Text style={styles.label}>{chip.label} ×</Text>
        </AppGlassPressable>
      ))}
    </ScrollView>
  );
}

function sameValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length &&
    left.every((value) => right.includes(value));
}

function makeStyles(t: DesignTokens) {
  return StyleSheet.create({
    row: { gap: t.spacing.sm },
    chip: {
      minHeight: t.hitTarget.min,
      justifyContent: 'center',
      paddingHorizontal: t.spacing.md,
    },
    label: {
      color: t.colors.textSecondary,
      ...t.foundation.typography.label,
    },
  });
}
