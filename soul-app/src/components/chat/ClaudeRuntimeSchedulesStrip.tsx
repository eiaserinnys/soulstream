import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { ApiClient } from '../../api/client';
import type {
  ClaudeRuntimeSchedule,
  ClaudeRuntimeScheduleStatus,
} from '../../api/types';
import { useChatStore } from '../../store/chatStore';
import { DESIGN_ICON_SIZE, useTokens, type DesignTokens } from '../../theme';
import { createSurfaceRoles } from '../../theme/surfaceRoles';
import { RUNTIME_STRIP_DETAILS_MAX_HEIGHT } from './runtimeStripOverflow';
import { canDeleteClaudeRuntimeSchedule } from './scheduleDeletePolicy';
import { DisclosureIcon } from '../DisclosureIcon';
import { useClaudeRuntimeSchedulesRefresh } from './useClaudeRuntimeListRefresh';

interface Props {
  sessionId: string;
  api: ApiClient | null;
}

export function ClaudeRuntimeSchedulesStrip({ sessionId, api }: Props) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);
  const runtime = useChatStore((s) => s.claudeRuntimeBySession[sessionId]);
  const schedules = useMemo(
    () => Object.values(runtime?.schedules ?? {}).sort(compareSchedules),
    [runtime],
  );
  const { loading, recoveryNeeded, refresh } = useClaudeRuntimeSchedulesRefresh(
    sessionId,
    api,
  );
  const [busyScheduleId, setBusyScheduleId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const errorCount = schedules.filter(
    (schedule) => schedule.status === 'failed' || schedule.status === 'orphaned',
  ).length;

  useEffect(() => {
    setExpanded(false);
  }, [api, sessionId]);

  const deleteSchedule = async (scheduleId: string) => {
    if (!api) return;
    setBusyScheduleId(scheduleId);
    try {
      await api.deleteClaudeSchedule(sessionId, scheduleId);
      await refresh();
    } catch (err: any) {
      Alert.alert('예약 삭제 실패', err?.message ?? '알 수 없는 오류');
    } finally {
      setBusyScheduleId(null);
    }
  };

  if (schedules.length === 0 && !loading && !recoveryNeeded) return null;

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => setExpanded((value) => !value)}
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          style={styles.headerButton}
        >
          <DisclosureIcon
            expanded={expanded}
            color={t.colors.textMuted}
            size={t.iconSize.standard}
          />
          <Ionicons name="calendar-outline" color={t.colors.textMuted} size={t.iconSize.standard} />
          <Text style={styles.title} numberOfLines={1}>Schedules</Text>
          {schedules.length > 0 || !recoveryNeeded ? (
            <Text style={styles.badge}>{schedules.length}</Text>
          ) : null}
          {recoveryNeeded ? <Text style={styles.errorBadge}>목록 미확인</Text> : null}
          {errorCount > 0 ? <Text style={styles.errorBadge}>{errorCount} error</Text> : null}
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => void refresh()}
          disabled={loading || !api}
          accessibilityLabel="예약 새로고침"
          style={styles.iconButton}
        >
          {loading ? (
            <ActivityIndicator size="small" color={t.colors.textMuted} />
          ) : (
            <Ionicons name="refresh-outline" color={t.colors.textMuted} size={t.iconSize.standard} />
          )}
        </TouchableOpacity>
      </View>
      {expanded ? (
        <ScrollView
          testID="runtime-schedules-details-scroll"
          style={styles.detailsScroll}
          contentContainerStyle={styles.detailsContent}
          nestedScrollEnabled
        >
          {schedules.map((schedule) => (
            <ScheduleRow
              key={schedule.scheduleId}
              schedule={schedule}
              busy={busyScheduleId === schedule.scheduleId}
              styles={styles}
              tokenTextOnAccent={t.colors.accentText}
              onDelete={() => void deleteSchedule(schedule.scheduleId)}
            />
          ))}
        </ScrollView>
      ) : null}
    </View>
  );
}

function ScheduleRow({
  schedule,
  busy,
  styles,
  tokenTextOnAccent,
  onDelete,
}: {
  schedule: ClaudeRuntimeSchedule;
  busy: boolean;
  styles: ReturnType<typeof makeStyles>;
  tokenTextOnAccent: string;
  onDelete: () => void;
}) {
  const canDelete = canDeleteClaudeRuntimeSchedule(schedule.status);
  return (
    <View style={styles.scheduleRow}>
      <View style={styles.scheduleText}>
        <View style={styles.titleRow}>
          <Text style={[styles.status, statusStyle(schedule.status, styles)]}>
            {schedule.status}
          </Text>
          <Text style={styles.kind}>{schedule.kind}</Text>
          <Text style={styles.scheduleId} numberOfLines={1}>
            {schedule.scheduleId}
          </Text>
        </View>
        <Text style={styles.summary} numberOfLines={2}>
          {schedule.prompt ?? schedule.cronExpression ?? 'scheduled prompt'}
        </Text>
        <Text style={styles.nextRun} numberOfLines={1}>
          {schedule.nextRunAt ? formatDateTime(schedule.nextRunAt) : 'no next run'}
        </Text>
      </View>
      <TouchableOpacity
        onPress={onDelete}
        disabled={busy || !canDelete}
        accessibilityLabel="예약 삭제"
        style={[styles.deleteButton, (busy || !canDelete) && styles.buttonDisabled]}
      >
        {busy ? (
          <ActivityIndicator size="small" color={tokenTextOnAccent} />
        ) : (
          <Ionicons name="trash-outline" color={tokenTextOnAccent} size={DESIGN_ICON_SIZE.compact} />
        )}
      </TouchableOpacity>
    </View>
  );
}

function compareSchedules(
  left: ClaudeRuntimeSchedule,
  right: ClaudeRuntimeSchedule,
): number {
  return (left.nextRunAt ?? '9999').localeCompare(right.nextRunAt ?? '9999');
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function statusStyle(
  status: ClaudeRuntimeScheduleStatus,
  styles: ReturnType<typeof makeStyles>,
) {
  if (status === 'active') return styles.statusActive;
  if (status === 'dispatching' || status === 'firing') return styles.statusFiring;
  if (status === 'failed' || status === 'orphaned') return styles.statusFailed;
  return styles.statusTerminal;
}

function makeStyles(t: DesignTokens) {
  const c = t.colors;
  const roles = createSurfaceRoles(t);
  return StyleSheet.create({
    container: {
      paddingHorizontal: t.spacing.md,
      paddingVertical: t.spacing.xs,
      gap: t.spacing.sm,
      backgroundColor: roles.chrome.tokenStyle.backgroundColor,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.spacing.sm,
      minHeight: t.hitTarget.min,
    },
    headerButton: {
      flex: 1,
      minWidth: 0,
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.spacing.sm,
      minHeight: t.hitTarget.min,
    },
    title: {
      flex: 1,
      color: c.textSecondary,
      fontSize: t.fontSize.meta,
      fontWeight: '600',
    },
    badge: {
      minHeight: t.controlHeight.chip,
      textAlignVertical: 'center',
      overflow: 'hidden',
      borderRadius: 6,
      paddingHorizontal: t.spacing.sm,
      paddingVertical: t.spacing.xxs,
      color: c.textMuted,
      backgroundColor: c.surfaceMuted,
      fontSize: t.fontSize.meta,
      fontWeight: '700',
    },
    errorBadge: {
      minHeight: t.controlHeight.chip,
      textAlignVertical: 'center',
      overflow: 'hidden',
      borderRadius: 6,
      paddingHorizontal: t.spacing.sm,
      paddingVertical: t.spacing.xxs,
      color: c.textPrimary,
      backgroundColor: `${c.error}1A`,
      fontSize: t.fontSize.meta,
      fontWeight: '700',
    },
    detailsScroll: {
      maxHeight: RUNTIME_STRIP_DETAILS_MAX_HEIGHT,
    },
    detailsContent: {
      gap: t.spacing.sm,
    },
    scheduleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      minHeight: t.foundation.minHeight.tool,
      gap: t.spacing.sm,
      borderRadius: t.radius.sm,
      paddingHorizontal: t.spacing.sm,
      paddingVertical: t.spacing.sm,
    },
    scheduleText: { flex: 1, minWidth: 0 },
    titleRow: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm },
    kind: {
      color: c.textMuted,
      fontSize: t.fontSize.meta,
      fontFamily: 'Menlo',
    },
    scheduleId: {
      flex: 1,
      color: c.textMuted,
      fontSize: t.fontSize.meta,
      fontFamily: 'Menlo',
    },
    summary: {
      color: c.textSecondary,
      fontSize: t.fontSize.meta,
      marginTop: t.spacing.xxs,
    },
    nextRun: {
      color: c.textMuted,
      fontSize: t.fontSize.meta,
      marginTop: t.spacing.xxs,
    },
    status: {
      minHeight: t.controlHeight.chip,
      textAlignVertical: 'center',
      overflow: 'hidden',
      borderRadius: 4,
      paddingHorizontal: t.spacing.sm,
      paddingVertical: t.spacing.xxs,
      fontSize: t.fontSize.meta,
      fontWeight: '700',
    },
    statusActive: { color: c.textPrimary, backgroundColor: `${c.success}1A` },
    statusFiring: { color: c.textPrimary, backgroundColor: c.warningBg },
    statusFailed: { color: c.textPrimary, backgroundColor: `${c.error}1A` },
    statusTerminal: { color: c.textMuted, backgroundColor: c.surfaceMuted },
    iconButton: {
      width: t.hitTarget.min,
      height: t.hitTarget.min,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: t.radius.sm,
    },
    deleteButton: {
      width: t.hitTarget.min,
      height: t.hitTarget.min,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: t.radius.sm,
      backgroundColor: c.error,
    },
    buttonDisabled: { opacity: 0.45 },
  });
}
