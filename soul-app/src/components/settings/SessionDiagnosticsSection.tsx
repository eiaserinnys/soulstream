import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Clipboard from 'expo-clipboard';
import {
  AccessibilityInfo,
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
import { settingsDiagnosticText } from './settingsDiagnosticText';
import { SettingsSurface } from './SettingsSurface';

export function SessionDiagnosticsSection({
  flattened = false,
}: {
  flattened?: boolean;
}) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);
  const revision = useRef(0);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; ++revision.current; }; }, []);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [records, setRecords] = useState<AppDiagnosticFailureRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [readError, setReadError] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copying' | 'copied' | 'error'>('idle');

  const copyMessage = copyStatus === 'copied' ? '전체 JSON을 클립보드에 복사했습니다.'
    : copyStatus === 'error' ? '클립보드에 복사하지 못했습니다. 다시 시도해 주세요.' : null;
  useEffect(() => { if (copyMessage) AccessibilityInfo.announceForAccessibility(copyMessage); }, [copyMessage]);

  const reload = useCallback(async () => {
    const request = ++revision.current;
    setLoading(true);
    setReadError(null);
    setCopyStatus('idle');
    try {
      const next = (await readAppDiagnosticFailures()).slice().reverse();
      if (alive.current && request === revision.current) { setRecords(next); setExpanded(new Set()); }
    } catch (error) {
      if (alive.current && request === revision.current) setReadError('다시 시도해 주세요.');
    } finally {
      if (alive.current && request === revision.current) setLoading(false);
    }
  }, []);

  const copyAll = useCallback(async () => {
    if (records.length === 0 || copyStatus === 'copying') return;
    const request = revision.current;
    setCopyStatus('copying');
    try {
      await Clipboard.setStringAsync(formatAppDiagnosticFailures(records.map(record => ({ ...record, error: { message: settingsDiagnosticText(record.error.message), stack: record.error.stack ? settingsDiagnosticText(record.error.stack) : null, componentStack: record.error.componentStack ? settingsDiagnosticText(record.error.componentStack) : null } }))));
      if (alive.current && request === revision.current) setCopyStatus('copied');
    } catch {
      if (alive.current && request === revision.current) setCopyStatus('error');
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
      <Text style={styles.empty}>앱과 기기 정보 및 관련 폴더·프로젝트·세션 식별자를 포함한 전체 JSON을 클립보드에 복사합니다.</Text>
      {copyMessage ? <Text accessibilityLiveRegion="polite" accessibilityRole={copyStatus === 'error' ? 'alert' : 'text'} style={copyStatus === 'error' ? styles.error : styles.success}>{copyMessage}</Text> : null}
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
        {!loading && !readError ? records.slice(0, 10).map((record, index) => (
          <View key={record.diagnosticId} style={styles.record}>
            <Text style={styles.meta}>
              {record.occurredAt} · {record.phase}
            </Text>
            <Text selectable style={styles.message}>{settingsDiagnosticText(record.error.message)}</Text>
            {record.error.stack || record.error.componentStack ? <TouchableOpacity testID={`session-diagnostic-expand-${index}`} accessibilityRole="button" accessibilityState={{ expanded: expanded.has(record.diagnosticId) }} style={styles.headingAction} onPress={() => setExpanded(current => { const next = new Set(current); if (next.has(record.diagnosticId)) next.delete(record.diagnosticId); else next.add(record.diagnosticId); return next; })}><Text style={styles.headingActionText}>{expanded.has(record.diagnosticId) ? '스택 접기' : '스택 펼쳐 보기'}</Text></TouchableOpacity> : null}
            {expanded.has(record.diagnosticId) ? (
              <Text
                testID={index === 0 ? 'session-diagnostic-stack' : undefined}
                selectable
                style={styles.stack}
              >
                {settingsDiagnosticText([record.error.stack, record.error.componentStack].filter(Boolean).join('\n\n'))}
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
      flexDirection: 'row', flexWrap: 'wrap',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    label: { color: t.colors.textPrimary, ...t.foundation.typography.body },
    headingActions: {
      flexDirection: 'row', flexWrap: 'wrap',
      alignItems: 'center',
      gap: t.spacing.xs,
    },
    headingAction: {
      minHeight: t.hitTarget.min,
      justifyContent: 'center',
      paddingHorizontal: t.spacing.sm,
    },
    headingActionText: { color: t.colors.accent, ...t.foundation.typography.body },
    surface: { padding: t.cardLayout.padding, gap: t.spacing.md },
    record: { gap: t.spacing.xs },
    meta: { color: t.colors.textTertiary, ...t.foundation.typography.meta },
    message: { color: t.colors.error, ...t.foundation.typography.body },
    stack: { color: t.colors.textSecondary, ...t.foundation.typography.meta },
    empty: { color: t.colors.textTertiary, ...t.foundation.typography.body },
    success: { color: t.colors.successText, ...t.foundation.typography.body },
    error: { color: t.colors.error, ...t.foundation.typography.body },
  });
}
