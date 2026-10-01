import React, { useCallback, useEffect, useMemo, useState } from 'react';
import * as Clipboard from 'expo-clipboard';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import {
  formatAppDiagnosticFailures,
  readAppDiagnosticFailures,
  type AppDiagnosticFailureRecord,
} from '../../lib/session-succession-diagnostics';
import { useTokens, type DesignTokens } from '../../theme';
import { SettingsSurface } from './SettingsSurface';

export function SessionDiagnosticsSection({
  flattened = false,
}: {
  flattened?: boolean;
}) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);
  const [records, setRecords] = useState<AppDiagnosticFailureRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [readError, setReadError] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copying' | 'copied' | 'error'>('idle');

  const reload = useCallback(async () => {
    setLoading(true);
    setReadError(null);
    setCopyStatus('idle');
    try {
      setRecords((await readAppDiagnosticFailures()).slice().reverse());
    } catch (error) {
      setReadError(errorText(error));
    } finally {
      setLoading(false);
    }
  }, []);

  const copyAll = useCallback(async () => {
    if (records.length === 0 || copyStatus === 'copying') return;
    setCopyStatus('copying');
    try {
      await Clipboard.setStringAsync(formatAppDiagnosticFailures(records));
      setCopyStatus('copied');
    } catch {
      setCopyStatus('error');
    }
  }, [copyStatus, records]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <View style={styles.section}>
      <View style={styles.headingRow}>
        <Text style={styles.label}>앱 진단 기록</Text>
        <View style={styles.headingActions}>
          <TouchableOpacity
            testID="session-diagnostics-copy-all"
            accessibilityRole="button"
            accessibilityLabel="앱 진단 기록 전체 복사"
            accessibilityState={{
              disabled: loading || Boolean(readError) || records.length === 0,
            }}
            disabled={loading || Boolean(readError) || records.length === 0}
            style={styles.headingAction}
            onPress={() => void copyAll()}
          >
            <Text style={styles.headingActionText}>
              {copyStatus === 'copying'
                ? '복사 중'
                : copyStatus === 'copied'
                  ? '복사됨'
                  : copyStatus === 'error'
                    ? '다시 복사'
                    : '전체 복사'}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            testID="session-diagnostics-refresh"
            accessibilityRole="button"
            style={styles.headingAction}
            onPress={() => void reload()}
          >
            <Text style={styles.headingActionText}>새로고침</Text>
          </TouchableOpacity>
        </View>
      </View>
      <SettingsSurface flattened={flattened} role="glassSoft" style={styles.surface}>
        {loading ? <ActivityIndicator color={t.colors.accent} /> : null}
        {!loading && readError ? (
          <Text accessibilityRole="alert" style={styles.error}>
            진단 기록을 읽지 못했습니다. {readError}
          </Text>
        ) : null}
        {!loading && !readError && records.length === 0 ? (
          <Text style={styles.empty}>저장된 오류가 없습니다.</Text>
        ) : null}
        {!loading && !readError ? records.map((record, index) => (
          <View key={record.diagnosticId} style={styles.record}>
            <Text style={styles.meta}>
              {record.occurredAt} · {record.phase}
            </Text>
            <Text selectable style={styles.message}>{record.error.message}</Text>
            {record.error.stack || record.error.componentStack ? (
              <Text
                testID={index === 0 ? 'session-diagnostic-stack' : undefined}
                selectable
                style={styles.stack}
              >
                {[record.error.stack, record.error.componentStack].filter(Boolean).join('\n\n')}
              </Text>
            ) : null}
          </View>
        )) : null}
      </SettingsSurface>
    </View>
  );
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function makeStyles(t: DesignTokens) {
  return StyleSheet.create({
    section: { gap: t.spacing.sm },
    headingRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    label: { color: t.colors.textPrimary, ...t.foundation.typography.label },
    headingActions: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.spacing.xs,
    },
    headingAction: {
      minHeight: t.hitTarget.min,
      justifyContent: 'center',
      paddingHorizontal: t.spacing.sm,
    },
    headingActionText: { color: t.colors.accent, ...t.foundation.typography.label },
    surface: { padding: t.cardLayout.padding, gap: t.spacing.md },
    record: { gap: t.spacing.xs },
    meta: { color: t.colors.textTertiary, ...t.foundation.typography.meta },
    message: { color: t.colors.error, ...t.foundation.typography.body },
    stack: { color: t.colors.textSecondary, ...t.foundation.typography.meta },
    empty: { color: t.colors.textTertiary, ...t.foundation.typography.body },
    error: { color: t.colors.error, ...t.foundation.typography.body },
  });
}
