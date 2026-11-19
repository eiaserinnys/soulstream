import React, { useCallback, useMemo, useState } from 'react';
import { Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { createPrimitiveRoles, useTokens, type DesignTokens } from '../../theme';
import { STATUS_DOT_SIZE } from '../chat/StatusDot';

export interface SettingsSegmentOption<T extends string> {
  value: T;
  label: string;
  count?: number;
  countBadge?: boolean;
  dot?: boolean;
}

/**
 * 같은 너비 칩의 열 수. 가장 넓은 칩(글자 폭 + 칩 장식)이 한 줄에 모두 들어가면 전부 한 줄,
 * 아니면 절반씩 줄을 나눈다. 아직 재지 못한 글자가 있으면 줄을 나눈 쪽에서 시작한다.
 */
export function evenRowColumns(count: number, innerWidth: number, labelWidths: readonly (number | undefined)[], chrome: number): number {
  const half = Math.ceil(count / 2);
  if (innerWidth <= 0 || labelWidths.some(width => width === undefined)) return half;
  const widest = Math.max(...(labelWidths as number[])) + chrome;
  return widest * count <= innerWidth ? count : half;
}

export function SettingsSegmentedControl<T extends string>({
  id,
  value,
  options,
  onChange,
  disabled = false,
  wrap = false,
  evenRows = false,
  variant = 'settings',
}: {
  id: string;
  value: T;
  options: readonly SettingsSegmentOption<T>[];
  onChange(value: T): void;
  disabled?: boolean;
  wrap?: boolean;
  /** 칩을 같은 너비로 두고, 한 줄에 다 들어가지 않으면 절반씩 두 줄로 놓는다. */
  evenRows?: boolean;
  variant?: 'settings' | 'detail';
}) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);
  const [focusedValue, setFocusedValue] = useState<T | null>(null);
  const [trackWidth, setTrackWidth] = useState(0);
  const [labelWidths, setLabelWidths] = useState<Partial<Record<T, number>>>({});
  const measureLabel = useCallback((key: T, width: number) => {
    setLabelWidths(previous => previous[key] === width ? previous : { ...previous, [key]: width });
  }, []);
  // 칩 하나가 글자 밖에 쓰는 가로 폭은 visual의 좌우 안쪽 여백과 고른 칩의 테두리다.
  const columns = evenRows ? evenRowColumns(options.length, trackWidth - 2 * t.spacing.xxs,
    options.map(option => labelWidths[option.value]), 2 * (t.spacing.xs + StyleSheet.hairlineWidth)) : 0;
  const evenHitTarget = evenRows ? { flex: 0, flexGrow: 0, flexShrink: 0, flexBasis: `${100 / columns}%` as const } : null;
  const flowWrap = wrap && !evenRows;

  return (
    <View testID={`settings-segment-${id}-track`}
      onLayout={evenRows ? event => setTrackWidth(event.nativeEvent.layout.width) : undefined}
      style={[variant === 'detail' ? styles.detailTrack : styles.track, (wrap || evenRows) && styles.wrapTrack]}>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <TouchableOpacity
            key={option.value}
            testID={`settings-segment-${id}-${option.value}`}
            accessibilityRole="button"
            accessibilityLabel={option.label}
            accessibilityState={{ selected, disabled }}
            disabled={disabled}
            {...(Platform.OS === 'web' ? { 'aria-pressed': selected } : {})}
            style={[variant === 'detail' ? styles.detailHitTarget : styles.hitTarget, flowWrap && styles.wrapHitTarget, evenHitTarget, disabled && styles.disabled]}
            onFocus={() => setFocusedValue(option.value)}
            onBlur={() => setFocusedValue(null)}
            onPress={() => onChange(option.value)}
          >
            <View
              testID={`settings-segment-${id}-${option.value}-visual`}
              pointerEvents="none"
              style={[variant === 'detail' ? styles.detailVisual : styles.visual, flowWrap && styles.wrapVisual,
                selected && (variant === 'detail' ? styles.detailSelected : styles.selected)]}
            >
              {variant === 'detail' ? (
                <View style={styles.labelContent}>
                  <Text numberOfLines={1} style={[styles.detailLabel, selected && styles.detailSelectedLabel]}>
                    {option.label}
                  </Text>
                  {option.count !== undefined ? <Text testID={`settings-segment-${id}-${option.value}-count`} style={[styles.detailCount, option.countBadge && styles.detailCountBadge]}>{option.count}</Text> : null}
                  {option.dot ? <View testID={`settings-segment-${id}-${option.value}-dot`} style={styles.detailDot} /> : null}
                </View>
              ) : (
                <Text testID={`settings-segment-${id}-${option.value}-label`} numberOfLines={wrap || evenRows ? 1 : undefined}
                  style={[styles.label, selected && styles.selectedLabel]}>
                  {option.label}
                </Text>
              )}
              <View
                testID={`settings-segment-${id}-${option.value}-focus`}
                pointerEvents="none"
                style={[styles.focusRing, variant === 'detail' && styles.detailFocusRing, focusedValue === option.value && styles.focused]}
              />
            </View>
          </TouchableOpacity>
        );
      })}
      {evenRows ? (
        // 고른 칩의 굵은 글자 폭을 칩 밖에서 잰다. 높이 0으로 접혀 보이지도 눌리지도 않는다.
        <View testID={`settings-segment-${id}-measure`} aria-hidden pointerEvents="none" style={styles.measure}>
          {options.map(option => (
            <Text key={option.value} testID={`settings-segment-${id}-${option.value}-measure`} numberOfLines={1}
              style={[styles.label, styles.selectedLabel]} onLayout={event => measureLabel(option.value, event.nativeEvent.layout.width)}>
              {option.label}
            </Text>
          ))}
        </View>
      ) : null}
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
    detailTrack: { flexDirection: 'row', alignItems: 'stretch', gap: t.uiSpacing.xs },
    hitTarget: {
      flex: 1,
      minHeight: t.hitTarget.min,
      justifyContent: 'center',
      // Chromium still paints auto outlines at zero width; use a solid style.
      ...(Platform.OS === 'web' ? { outlineStyle: 'solid' as const, outlineWidth: 0 } : {}),
    },
    detailHitTarget: {
      flexShrink: 0,
      minHeight: t.hitTarget.min,
      justifyContent: 'center',
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
    detailVisual: {
      minHeight: t.foundation.minHeight.segment,
      paddingHorizontal: t.uiSpacing.sm,
      paddingVertical: t.uiSpacing.xs,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: t.foundation.radius.round,
      flexDirection: 'row',
    },
    detailSelected: { backgroundColor: t.colors.surface },
    labelContent: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: t.uiSpacing.xs },
    detailLabel: { ...t.foundation.typography.body, fontWeight: '600', color: t.colors.textSecondary, textAlign: 'center' },
    detailSelectedLabel: { color: t.colors.textPrimary },
    detailCountBadge: { backgroundColor: t.colors.accentTint, color: t.colors.accent, borderRadius: t.foundation.radius.round, paddingHorizontal: t.uiSpacing.xs, fontWeight: '700' },
    detailCount: { ...t.foundation.typography.meta, color: t.colors.textPrimary },
    detailDot: { width: STATUS_DOT_SIZE, height: STATUS_DOT_SIZE, borderRadius: t.foundation.radius.round, backgroundColor: t.colors.accent },
    detailFocusRing: { borderRadius: t.foundation.radius.round },
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
    disabled: { opacity: 0.45 },
    measure: { position: 'absolute', left: 0, top: 0, height: 0, overflow: 'hidden', alignItems: 'flex-start' },
  });
}
