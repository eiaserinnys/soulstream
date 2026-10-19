import React, { useCallback, useMemo, useRef, useState } from 'react';
import { PanResponder, Pressable, StyleSheet, Text, View } from 'react-native';
import { useTokens } from '../../../theme';
import { formatUsageStatsTokenCount, formatUsageStatsUsd } from '../../../../../packages/soul-ui/src/lib/usage-stats-format';

export interface UsageStackSegment {
  id: string;
  label: string;
  value: number | null;
  color: string;
  partial?: boolean;
}

export interface UsageStackBucket {
  id: string;
  label: string;
  description: string;
  segments: UsageStackSegment[];
  selectable: boolean;
  availability: 'available' | 'before-coverage' | 'future';
}

type Measure = 'tokens' | 'cost';

export function UsageStackedBars({
  buckets,
  selectedBucket,
  onSelectBucket,
  onDragBucket,
  measure,
  testID,
}: {
  buckets: UsageStackBucket[];
  selectedBucket?: string | null;
  onSelectBucket?: (bucketId: string) => void;
  onDragBucket?: (bucketId: string) => void;
  measure: Measure;
  testID: string;
}) {
  const t = useTokens();
  const chartRef = useRef<View>(null);
  const chartLeft = useRef(0);
  const lastDragBucket = useRef<string | null>(null);
  const didDrag = useRef(false);
  const [chartWidth, setChartWidth] = useState(0);
  const totals = useMemo(() => buckets.map(bucket => {
    const known = bucket.segments.flatMap(segment => typeof segment.value === 'number' ? [segment.value] : []);
    return known.length === 0 ? null : known.reduce((sum, value) => sum + value, 0);
  }), [buckets]);
  const maximum = Math.max(0, ...totals.flatMap(total => total === null ? [] : [total]));
  const missingLabel = measure === 'tokens' ? '미기록' : '정가 미확인';
  const chartStatus = buckets.length > 0 && buckets.every(bucket => bucket.availability === 'before-coverage')
    ? '이 기간은 기록 전입니다'
    : buckets.length > 0 && buckets.every(bucket => bucket.segments.length === 0)
      ? '이 기간에 기록이 없습니다'
    : buckets.some(bucket => bucket.segments.length > 0) && totals.every(total => total === null)
      ? missingLabel
      : null;
  const axisLabel = maximum > 0 ? formatValue(maximum, measure) : '0';
  const chartHeight = t.hitTarget.min * 4;

  const selectDragPosition = useCallback((pageX: number) => {
    if (chartWidth <= 0 || !onDragBucket) return;
    const index = Math.floor(((pageX - chartLeft.current) / chartWidth) * buckets.length);
    const bucket = buckets[Math.max(0, Math.min(buckets.length - 1, index))];
    if (!bucket?.selectable || bucket.id === lastDragBucket.current) return;
    lastDragBucket.current = bucket.id;
    onDragBucket(bucket.id);
  }, [buckets, chartWidth, onDragBucket]);

  const panResponder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => false,
    onMoveShouldSetPanResponder: (_, gesture) => Boolean(onDragBucket)
      && Math.abs(gesture.dx) > t.spacing.xs
      && Math.abs(gesture.dx) > Math.abs(gesture.dy),
    onMoveShouldSetPanResponderCapture: (_, gesture) => Boolean(onDragBucket)
      && Math.abs(gesture.dx) > t.spacing.xs
      && Math.abs(gesture.dx) > Math.abs(gesture.dy),
    onPanResponderGrant: (_, gesture) => {
      lastDragBucket.current = null;
      didDrag.current = true;
      selectDragPosition(gesture.x0);
    },
    onPanResponderMove: (_, gesture) => selectDragPosition(gesture.moveX),
    onPanResponderRelease: () => {
      lastDragBucket.current = null;
      setTimeout(() => { didDrag.current = false; }, 0);
    },
    onPanResponderTerminate: () => {
      lastDragBucket.current = null;
      setTimeout(() => { didDrag.current = false; }, 0);
    },
  }), [onDragBucket, selectDragPosition, t.spacing.xs]);

  return (
    <View
      ref={chartRef}
      testID={`${testID}-chart`}
      {...panResponder.panHandlers}
      onLayout={event => {
        const nextWidth = event.nativeEvent.layout.width;
        setChartWidth(current => current === nextWidth ? current : nextWidth);
        chartRef.current?.measureInWindow(x => { chartLeft.current = x; });
      }}
      style={{ minWidth: 0 }}
    >
      <Text accessibilityElementsHidden importantForAccessibility="no" style={{ ...t.foundation.typography.meta, color: t.colors.textTertiary, textAlign: 'right' }}>{axisLabel}</Text>
      {chartStatus ? <Text accessibilityRole="text" style={{ ...t.foundation.typography.meta, color: t.colors.textSecondary }}>{chartStatus}</Text> : null}
      <View style={{ flexDirection: 'row', borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: t.colors.border }}>
        {buckets.map((bucket, index) => {
          const total = totals[index] ?? null;
          const hasUnknown = bucket.segments.length === 0 || bucket.segments.some(segment => segment.value === null || segment.partial);
          const availabilityLabel = bucket.availability === 'before-coverage'
            ? '기록 전'
            : bucket.availability === 'future' ? '아직 기록되지 않음' : null;
          const valueLabel = availabilityLabel ?? (total === null
            ? missingLabel
            : `${formatValue(total, measure)}${hasUnknown ? '+' : ''}`);
          const hasBar = total !== null && total > 0 && maximum > 0;
          const selected = selectedBucket === bucket.id;
          const label = (
            <>
              <View style={{ width: '80%', height: chartHeight, justifyContent: 'flex-end', overflow: 'hidden', borderRadius: t.radius.sm, backgroundColor: t.colors.surfaceMuted }}>
                {hasBar ? bucket.segments.map(segment => typeof segment.value === 'number' && segment.value > 0
                  ? <View key={segment.id} accessibilityElementsHidden importantForAccessibility="no" style={{ height: `${(segment.value / maximum) * 100}%`, backgroundColor: segment.color }} />
                  : null) : null}
                {!chartStatus && !hasBar && total === null ? <Text style={{ ...t.foundation.typography.meta, color: t.colors.textTertiary, textAlign: 'center' }}>?</Text> : null}
              </View>
              <Text numberOfLines={1} style={{ ...t.foundation.typography.meta, color: t.colors.textTertiary, width: '100%', textAlign: 'center' }}>{bucket.label}</Text>
            </>
          );

          return (
            <Pressable
              key={bucket.id}
              testID={`${testID}-${bucket.id}`}
              accessibilityRole="button"
              accessibilityLabel={`${bucket.description}, ${valueLabel}`}
              accessibilityState={{ selected, disabled: !bucket.selectable }}
              disabled={!bucket.selectable || !onSelectBucket}
              onPress={() => {
                if (didDrag.current) {
                  didDrag.current = false;
                  return;
                }
                onSelectBucket?.(bucket.id);
              }}
              style={{ flex: 1, minWidth: 0, alignItems: 'center', justifyContent: 'space-between', gap: t.spacing.xxs, backgroundColor: selected ? t.colors.accentTint : 'transparent', opacity: bucket.selectable ? 1 : 0.48 }}
            >
              {label}
            </Pressable>
          );
        })}
      </View>
      <Text accessibilityElementsHidden importantForAccessibility="no" style={{ ...t.foundation.typography.meta, color: t.colors.textTertiary }}>0</Text>
    </View>
  );
}

function formatValue(value: number, measure: Measure): string {
  return measure === 'tokens' ? formatUsageStatsTokenCount(value) : formatUsageStatsUsd(value);
}
