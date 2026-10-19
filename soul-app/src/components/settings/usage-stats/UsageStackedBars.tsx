import React from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useTokens } from '../../../theme';

export interface UsageStackSegment {
  id: string;
  label: string;
  value: number | null;
  color: string;
}

export interface UsageStackBucket {
  id: string;
  label: string;
  segments: UsageStackSegment[];
}

export function UsageStackedBars({
  buckets,
  selectedBucket,
  onSelectBucket,
  testID,
}: {
  buckets: UsageStackBucket[];
  selectedBucket?: string | null;
  onSelectBucket?: (bucketId: string) => void;
  testID: string;
}) {
  const t = useTokens();
  const max = Math.max(0, ...buckets.map(bucket => bucket.segments.reduce((sum, segment) => sum + (segment.value ?? 0), 0)));
  const chartHeight = t.foundation.typography.body.lineHeight * 6;
  const columnWidth = Math.max(t.hitTarget.min, t.spacing.xxxl);
  const barWidth = t.spacing.lg;

  return (
    <ScrollView
      horizontal
      nestedScrollEnabled
      showsHorizontalScrollIndicator={false}
      testID={`${testID}-scroll`}
      contentContainerStyle={{ alignItems: 'flex-end', gap: t.spacing.xs, paddingBottom: t.spacing.xs }}
    >
      {buckets.map(bucket => {
        const total = bucket.segments.reduce((sum, segment) => sum + (segment.value ?? 0), 0);
        const stack = (
          <View style={{ width: barWidth, height: chartHeight, justifyContent: 'flex-end', overflow: 'hidden', borderRadius: t.radius.sm, backgroundColor: t.colors.surfaceMuted }}>
            {bucket.segments.map(segment => {
              const value = segment.value ?? 0;
              if (value <= 0 || max <= 0) return null;
              return <View key={segment.id} accessibilityElementsHidden importantForAccessibility="no" style={{ height: `${(value / max) * 100}%`, backgroundColor: segment.color }} />;
            })}
          </View>
        );
        const label = (
          <View style={{ width: columnWidth, alignItems: 'center', gap: t.spacing.xxs }}>
            {stack}
            <Text numberOfLines={1} style={{ ...t.foundation.typography.meta, color: t.colors.textSecondary }}>{bucket.label}</Text>
          </View>
        );

        return onSelectBucket ? (
          <TouchableOpacity
            key={bucket.id}
            testID={`${testID}-${bucket.id}`}
            accessibilityRole="button"
            accessibilityLabel={`${bucket.label} 사용량 ${total}`}
            accessibilityState={{ selected: selectedBucket === bucket.id }}
            onPress={() => onSelectBucket(bucket.id)}
            style={{ minWidth: columnWidth, alignItems: 'center', paddingHorizontal: t.spacing.xxs, borderRadius: t.radius.md, borderWidth: StyleSheet.hairlineWidth, borderColor: selectedBucket === bucket.id ? t.colors.accent : 'transparent' }}
          >
            {label}
          </TouchableOpacity>
        ) : <View key={bucket.id} style={{ minWidth: columnWidth, alignItems: 'center' }}>{label}</View>;
      })}
    </ScrollView>
  );
}
