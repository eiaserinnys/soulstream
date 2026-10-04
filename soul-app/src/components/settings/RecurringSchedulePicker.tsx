import React, { useMemo } from 'react';
import { StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';

import { useTokens, type DesignTokens } from '../../theme';
import type { RecurringScheduleDraft, RecurringScheduleMode } from './recurringSchedule';

const MODES: Array<{ id: RecurringScheduleMode; label: string }> = [
  { id: 'daily', label: '매일' },
  { id: 'weekdays', label: '평일' },
  { id: 'weekly', label: '매주 요일' },
  { id: 'monthly', label: '매월 날짜' },
  { id: 'advanced', label: '고급 cron' },
];
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

export function RecurringSchedulePicker({
  value,
  onChange,
}: {
  value: RecurringScheduleDraft;
  onChange(value: RecurringScheduleDraft): void;
}) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);
  const patch = (next: Partial<RecurringScheduleDraft>) => onChange({ ...value, ...next });
  const updateTime = (index: number, time: string) => patch({
    times: value.times.map((current, currentIndex) => currentIndex === index ? time : current),
  });
  return <View testID="recurring-schedule-picker" style={styles.block}>
    <Text style={styles.label}>반복</Text>
    <ChoiceRow
      selected={value.mode}
      options={MODES}
      onSelect={(mode) => patch({ mode: mode as RecurringScheduleMode })}
      testIDPrefix="recurring-schedule-mode"
    />
    {value.mode === 'advanced' ? <View style={styles.block}>
      <Text style={styles.label}>고급 cron 직접 편집</Text>
      <TextInput
        testID="recurring-schedule-advanced-cron"
        accessibilityLabel="고급 cron"
        style={[styles.input, styles.multiline]}
        value={value.advancedExpressions}
        multiline
        onChangeText={(advancedExpressions) => patch({ advancedExpressions })}
        placeholder="0 9 * * 1-5"
        placeholderTextColor={t.colors.textPlaceholder}
      />
      <Text style={styles.help}>한 줄에 5필드 cron 하나를 입력합니다.</Text>
    </View> : <>
      <Text style={styles.label}>실행 시각</Text>
      {value.times.map((time, index) => <View key={`time-${index}`} style={styles.timeRow}>
        <TextInput
          testID={`recurring-schedule-time-${index}`}
          accessibilityLabel={`실행 시각 ${index + 1}`}
          style={[styles.input, styles.timeInput]}
          value={time}
          onChangeText={(next) => updateTime(index, next)}
          placeholder="09:00"
          placeholderTextColor={t.colors.textPlaceholder}
        />
        {value.times.length > 1 ? <ChoiceButton label="삭제" onPress={() => patch({
          times: value.times.filter((_, currentIndex) => currentIndex !== index),
        })} /> : null}
      </View>)}
      <ChoiceButton
        label="시각 추가"
        onPress={() => patch({ times: [...value.times, '12:00'] })}
        testID="recurring-schedule-add-time"
      />
      {value.mode === 'weekly' ? <View style={styles.block}>
        <Text style={styles.label}>요일</Text>
        <ChoiceRow
          selected={null}
          options={WEEKDAYS.map((label, day) => ({ id: String(day), label }))}
          onSelect={(selectedDay) => {
            const day = Number(selectedDay);
            patch({ weekdays: value.weekdays.includes(day)
              ? value.weekdays.filter((current) => current !== day)
              : [...value.weekdays, day] });
          }}
          selectedMany={new Set(value.weekdays.map(String))}
          testIDPrefix="recurring-schedule-weekday"
        />
      </View> : null}
      {value.mode === 'monthly' ? <View style={styles.block}>
        <Text style={styles.label}>매월 날짜</Text>
        <ChoiceRow
          selected={null}
          options={Array.from({ length: 31 }, (_, index) => ({ id: String(index + 1), label: String(index + 1) }))}
          onSelect={(selectedDay) => {
            const day = Number(selectedDay);
            patch({ monthDays: value.monthDays.includes(day)
              ? value.monthDays.filter((current) => current !== day)
              : [...value.monthDays, day] });
          }}
          selectedMany={new Set(value.monthDays.map(String))}
          grid
          testIDPrefix="recurring-schedule-month-day"
        />
      </View> : null}
    </>}
  </View>;
}

function ChoiceRow({
  selected,
  selectedMany,
  options,
  onSelect,
  testIDPrefix,
  grid = false,
}: {
  selected: string | null;
  selectedMany?: ReadonlySet<string>;
  options: Array<{ id: string; label: string }>;
  onSelect(value: string): void;
  testIDPrefix: string;
  grid?: boolean;
}) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);
  const renderOption = (option: { id: string; label: string }) => {
    const active = selected === option.id || selectedMany?.has(option.id) === true;
    return <TouchableOpacity
      key={option.id}
      testID={`${testIDPrefix}-${option.id}`}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      style={[styles.option, grid && { flex: 1, minWidth: 0, paddingHorizontal: 0 }, active && styles.optionSelected]}
      onPress={() => onSelect(option.id)}
    ><Text style={[styles.optionText, active && styles.optionTextSelected]}>{option.label}</Text></TouchableOpacity>;
  };
  if (grid) return <View testID="recurring-month-grid" style={{ gap: t.spacing.xs }}>{Array.from({ length: Math.ceil(options.length / 7) }, (_, row) => <View key={row} style={{ flexDirection: 'row' }}>{Array.from({ length: 7 }, (_, column) => {
    const option = options[row * 7 + column];
    return option ? renderOption(option) : <View key={`empty-${column}`} style={{ flex: 1 }}/>;
  })}</View>)}</View>;
  return <View style={styles.options}>{options.map(renderOption)}</View>;
}

function ChoiceButton({ label, onPress, testID }: { label: string; onPress(): void; testID?: string }) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);
  return <TouchableOpacity testID={testID} accessibilityRole="button" style={styles.addButton} onPress={onPress}>
    <Text style={styles.optionText}>{label}</Text>
  </TouchableOpacity>;
}

function makeStyles(t: DesignTokens) {
  return StyleSheet.create({
    block: { gap: t.spacing.xs },
    label: { ...t.foundation.typography.body, color: t.colors.textSecondary, marginTop: t.spacing.xs },
    help: { ...t.foundation.typography.body, color: t.colors.textMuted },
    input: {
      minHeight: t.hitTarget.min,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.colors.border,
      borderRadius: t.foundation.radius.field,
      color: t.colors.textPrimary,
      paddingHorizontal: t.spacing.sm,
      paddingVertical: t.spacing.sm,
      ...t.foundation.typography.body,
    },
    multiline: { minHeight: 92, textAlignVertical: 'top' },
    timeRow: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.xs },
    timeInput: { flex: 1 },
    options: { flexDirection: 'row', flexWrap: 'wrap', gap: t.spacing.xs },
    option: {
      minHeight: t.hitTarget.min,
      minWidth: t.hitTarget.min,
      justifyContent: 'center',
      alignItems: 'center',
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.colors.border,
      borderRadius: t.foundation.radius.field,
      paddingHorizontal: t.spacing.sm,
      paddingVertical: t.spacing.xs,
    },
    optionSelected: { borderColor: t.colors.accent, backgroundColor: t.colors.accentTint },
    optionText: { ...t.foundation.typography.body, color: t.colors.textSecondary },
    optionTextSelected: { color: t.colors.textPrimary, fontWeight: '700' },
    addButton: {
      alignSelf: 'flex-start',
      minHeight: t.hitTarget.min,
      minWidth: t.hitTarget.min,
      justifyContent: 'center',
      alignItems: 'center',
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.colors.border,
      borderRadius: t.foundation.radius.field,
      paddingHorizontal: t.spacing.sm,
      paddingVertical: t.spacing.xs,
    },
  });
}
