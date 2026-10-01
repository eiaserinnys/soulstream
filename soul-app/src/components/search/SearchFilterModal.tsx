import React, { useMemo } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { Folder } from '../../api/types';
import {
  DEFAULT_SEARCH_FILTERS,
  type SearchEventCategory,
  type SearchFilters,
  type SearchPeriod,
} from '../../store/searchStore';
import { useTokens, type DesignTokens } from '../../theme';
import { AppModalSurface } from '../AppModalSurface';
import { AppGlassPressable } from '../AppGlassCard';
import { GlassButton } from '../GlassSurface';

const STATUS_OPTIONS = [
  ['running', '실행 중'],
  ['idle', '대기'],
  ['completed', '완료'],
  ['error', '오류'],
] as const;
const PERIOD_OPTIONS: Array<[SearchPeriod, string]> = [
  ['today', '오늘'],
  ['7d', '7일'],
  ['30d', '30일'],
  ['all', '전체'],
];
const EVENT_OPTIONS: Array<[SearchEventCategory, string]> = [
  ['messages', '메시지'],
  ['responses', '응답'],
  ['thinking', '생각'],
];

export function SearchFilterModal({
  visible,
  tablet,
  filters,
  folders,
  nodeIds,
  backends,
  onChange,
  onClose,
}: {
  visible: boolean;
  tablet: boolean;
  filters: SearchFilters;
  folders: Folder[];
  nodeIds: string[];
  backends: string[];
  onChange(filters: Partial<SearchFilters>): void;
  onClose(): void;
}) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);
  return (
    <AppModalSurface
      visible={visible}
      variant={tablet ? 'popover' : 'compact'}
      modalId="modal_search_filter"
      surfaceTestID="search-filter-surface"
      onRequestClose={onClose}
    >
      <View style={styles.header}>
        <Text style={styles.title}>검색 필터</Text>
        <GlassButton
          accessibilityLabel="검색 필터 닫기"
          onPress={onClose}
          style={styles.close}
        >
          <Ionicons
            name="close"
            color={t.colors.textPrimary}
            size={t.iconSize.standard}
          />
        </GlassButton>
      </View>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.content}
      >
        <SingleChoice
          title="폴더"
          value={filters.folderId}
          options={folders.map((folder) => [folder.id, folder.name])}
          onChange={(folderId) => onChange({ folderId })}
          styles={styles}
        />
        <SingleChoice
          title="노드"
          value={filters.nodeId}
          options={nodeIds.map((nodeId) => [nodeId, nodeId])}
          onChange={(nodeId) => onChange({ nodeId })}
          styles={styles}
        />
        <MultiChoice
          title="상태"
          values={filters.statuses}
          options={STATUS_OPTIONS}
          onChange={(statuses) => onChange({ statuses })}
          styles={styles}
        />
        <MultiChoice
          title="백엔드"
          values={filters.backends}
          options={backends.map((backend) => [backend, backend])}
          onChange={(next) => onChange({ backends: next })}
          styles={styles}
        />
        <SingleChoice
          title="기간"
          value={filters.period}
          allowAll={false}
          options={PERIOD_OPTIONS}
          onChange={(period) => onChange({ period: period as SearchPeriod })}
          styles={styles}
        />
        <MultiChoice
          title="발화 종류"
          values={filters.eventCategories}
          options={EVENT_OPTIONS}
          onChange={(eventCategories) => onChange({
            eventCategories: eventCategories as SearchEventCategory[],
          })}
          styles={styles}
        />
      </ScrollView>
      <View style={styles.footer}>
        <GlassButton
          accessibilityLabel="검색 필터 초기화"
          onPress={() => onChange({ ...DEFAULT_SEARCH_FILTERS })}
          style={styles.reset}
        >
          <Text style={styles.resetText}>초기화</Text>
        </GlassButton>
        <GlassButton
          accessibilityLabel="검색 필터 적용"
          onPress={onClose}
          style={styles.apply}
        >
          <Text style={styles.applyText}>적용</Text>
        </GlassButton>
      </View>
    </AppModalSurface>
  );
}

function SingleChoice<T extends string>({
  title,
  value,
  options,
  allowAll = true,
  onChange,
  styles,
}: {
  title: string;
  value: T | null;
  options: ReadonlyArray<readonly [T, string]>;
  allowAll?: boolean;
  onChange(value: T | null): void;
  styles: ReturnType<typeof makeStyles>;
}) {
  return (
    <FilterSection title={title} styles={styles}>
      {allowAll ? (
        <FilterChip
          label="전체"
          active={value === null}
          onPress={() => onChange(null)}
          styles={styles}
        />
      ) : null}
      {options.map(([option, label]) => (
        <FilterChip
          key={option}
          label={label}
          active={value === option}
          onPress={() => onChange(option)}
          styles={styles}
        />
      ))}
    </FilterSection>
  );
}

function MultiChoice<T extends string>({
  title,
  values,
  options,
  onChange,
  styles,
}: {
  title: string;
  values: T[];
  options: ReadonlyArray<readonly [T, string]>;
  onChange(values: T[]): void;
  styles: ReturnType<typeof makeStyles>;
}) {
  if (options.length === 0) return null;
  return (
    <FilterSection title={title} styles={styles}>
      {options.map(([option, label]) => (
        <FilterChip
          key={option}
          label={label}
          active={values.includes(option)}
          onPress={() => onChange(toggle(values, option))}
          styles={styles}
        />
      ))}
    </FilterSection>
  );
}

function FilterSection({
  title,
  styles,
  children,
}: {
  title: string;
  styles: ReturnType<typeof makeStyles>;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <View style={styles.chips}>{children}</View>
    </View>
  );
}

function FilterChip({
  label,
  active,
  onPress,
  styles,
}: {
  label: string;
  active: boolean;
  onPress(): void;
  styles: ReturnType<typeof makeStyles>;
}) {
  return (
    <AppGlassPressable
      style={[styles.chip, active && styles.chipActive]}
      contentStyle={styles.chipContent}
      accessibilityLabel={`${label}${active ? ', 선택됨' : ''}`}
      onPress={onPress}
    >
      <Text style={[styles.chipText, active && styles.chipTextActive]}>
        {label}
      </Text>
    </AppGlassPressable>
  );
}

function toggle<T>(values: T[], value: T): T[] {
  return values.includes(value)
    ? values.filter((item) => item !== value)
    : [...values, value];
}

function makeStyles(t: DesignTokens) {
  return StyleSheet.create({
    header: {
      minHeight: t.foundation.minHeight.primary,
      flexDirection: 'row',
      alignItems: 'center',
      paddingLeft: t.spacing.lg,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.colors.border,
    },
    title: {
      flex: 1,
      color: t.colors.textPrimary,
      ...t.foundation.typography.section,
    },
    close: {
      minWidth: t.hitTarget.min,
      minHeight: t.hitTarget.min,
      alignItems: 'center',
      justifyContent: 'center',
    },
    content: {
      padding: t.spacing.lg,
      gap: t.spacing.lg,
    },
    section: { gap: t.spacing.sm },
    sectionTitle: {
      color: t.colors.textSecondary,
      ...t.foundation.typography.label,
    },
    chips: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: t.spacing.sm,
    },
    chip: { flexShrink: 1 },
    chipActive: {
      borderWidth: 1,
      borderColor: t.colors.accent,
    },
    chipContent: {
      minHeight: t.hitTarget.min,
      justifyContent: 'center',
      paddingHorizontal: t.spacing.md,
    },
    chipText: {
      color: t.colors.textSecondary,
      ...t.foundation.typography.body,
    },
    chipTextActive: { color: t.colors.textPrimary, fontWeight: '600' },
    footer: {
      flexDirection: 'row',
      gap: t.spacing.sm,
      padding: t.spacing.lg,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: t.colors.border,
    },
    reset: {
      flex: 1,
      minHeight: t.foundation.minHeight.primary,
      alignItems: 'center',
      justifyContent: 'center',
    },
    apply: {
      flex: 2,
      minHeight: t.foundation.minHeight.primary,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: t.colors.accent,
    },
    resetText: {
      color: t.colors.textSecondary,
      ...t.foundation.typography.body,
      fontWeight: '600',
    },
    applyText: {
      color: t.colors.accentText,
      ...t.foundation.typography.body,
      fontWeight: '700',
    },
  });
}
