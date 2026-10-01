import React, { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useTokens, type DesignTokens } from '../../theme';
import { LiquidGlassButton } from '../LiquidGlassButton';

export function DailyHeaderActions({
  onOpenReview,
  onOpenNewFolder,
}: {
  onOpenReview(): void;
  onOpenNewFolder(): void;
}) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);
  return (
    <View testID="daily-header-actions" style={styles.row}>
      <LiquidGlassButton
        iconOnly
        testID="daily-review-action"
        accessibilityLabel="오늘 작업 검토"
        accessibilityHint="이전 날짜에 남은 카드를 하나씩 정리합니다"
        onPress={onOpenReview}
        contentStyle={styles.action}
      >
        <Ionicons name="sunny-outline" color={t.colors.textPrimary} size={t.iconSize.navigation} />
      </LiquidGlassButton>
      <LiquidGlassButton
        iconOnly
        testID="daily-new-task-action"
        accessibilityLabel="새 작업"
        accessibilityHint="새 카드 입력 시트를 엽니다"
        onPress={onOpenNewFolder}
        contentStyle={styles.action}
      >
        <Ionicons name="add-outline" color={t.colors.textPrimary} size={t.iconSize.navigation} />
      </LiquidGlassButton>
    </View>
  );
}

function makeStyles(t: DesignTokens) {
  return StyleSheet.create({
    row: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.xs },
    action: {
      minWidth: t.hitTarget.min,
      minHeight: t.hitTarget.min,
      alignItems: 'center',
      justifyContent: 'center',
    },
  });
}
