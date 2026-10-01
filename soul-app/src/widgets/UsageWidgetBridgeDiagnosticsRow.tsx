import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTokens, type DesignTokens } from '../theme';
import { useUsageWidgetBridgeDiagnostics } from './usageWidgetBridge';

export function UsageWidgetBridgeDiagnosticsRow() {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);
  const diagnostics = useUsageWidgetBridgeDiagnostics();
  const nativeStatus = diagnostics.hydrated
    ? diagnostics.nativeModuleAvailable ? '사용 가능' : '사용 불가'
    : '확인 중';

  return (
    <>
      <Text style={styles.label}>위젯 데이터 브리지</Text>
      <View testID="settings-widget-bridge" style={styles.row}>
        <Text style={styles.text}>네이티브 모듈: {nativeStatus}</Text>
        <Text style={styles.text}>
          서버 URL: {diagnostics.serverURLRecorded ? '기록됨' : '없음'}
        </Text>
        <Text style={styles.text}>
          인증 토큰: {diagnostics.authTokenRecorded ? '기록됨' : '없음'}
        </Text>
        <Text style={styles.text}>
          마지막 동기화: {formatSyncTime(diagnostics.lastSyncAt)}
        </Text>
        {diagnostics.error ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {diagnostics.error}
          </Text>
        ) : null}
      </View>
    </>
  );
}

function formatSyncTime(value: string | null): string {
  if (!value) return '없음';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString('ko-KR');
}

function makeStyles(t: DesignTokens) {
  return StyleSheet.create({
    label: {
      ...t.foundation.typography.section,
      color: t.colors.textSecondary,
      marginTop: t.spacing.lg,
      marginBottom: t.spacing.sm,
    },
    row: {
      gap: t.spacing.xs,
      marginBottom: t.spacing.xl,
      paddingHorizontal: t.spacing.sm,
    },
    text: {
      ...t.foundation.typography.meta,
      color: t.colors.textSecondary,
    },
    error: {
      ...t.foundation.typography.meta,
      color: t.colors.errorText,
      marginTop: t.spacing.xs,
    },
  });
}
