import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { ApiClient } from '../../api/client';
import type {
  ClaudeRuntimeMode,
  ClaudeRuntimeTask,
  ClaudeRuntimeTaskOutputResponse,
  ClaudeRuntimeTaskStatus,
} from '../../api/types';
import { useChatStore } from '../../store/chatStore';
import { DESIGN_ICON_SIZE, useTokens, type DesignTokens } from '../../theme';
import { createSurfaceRoles } from '../../theme/surfaceRoles';
import { RUNTIME_STRIP_DETAILS_MAX_HEIGHT } from './runtimeStripOverflow';
import { DisclosureIcon } from '../DisclosureIcon';
import { AppModalSurface } from '../AppModalSurface';
import { CompactTouchTarget } from '../CompactTouchTarget';
import { useClaudeRuntimeTasksRefresh } from './useClaudeRuntimeListRefresh';

interface Props {
  sessionId: string;
  api: ApiClient | null;
}

const TERMINAL_STATUSES = new Set<ClaudeRuntimeTaskStatus>([
  'completed', 'failed', 'stopped', 'killed',
]);

export function ClaudeRuntimeTasksStrip({ sessionId, api }: Props) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);
  const runtime = useChatStore((s) => s.claudeRuntimeBySession[sessionId]);
  const tasks = useMemo(
    () => Object.values(runtime?.tasks ?? {}).sort((a, b) => b.updatedAt - a.updatedAt),
    [runtime],
  );
  const planMode = runtime?.planMode ?? null;
  const worktreeMode = runtime?.worktreeMode ?? null;
  const hasModeState = Boolean(planMode || worktreeMode);
  const { loading, recoveryNeeded, refresh } = useClaudeRuntimeTasksRefresh(
    sessionId,
    api,
  );
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);
  const [output, setOutput] = useState<ClaudeRuntimeTaskOutputResponse | null>(null);
  const [expanded, setExpanded] = useState(false);
  const runningCount = tasks.filter((task) => task.status === 'running' || task.status === 'pending').length;
  const errorCount = tasks.filter((task) => task.status === 'failed' || task.status === 'killed').length;

  useEffect(() => {
    setExpanded(false);
  }, [api, sessionId]);

  const openOutput = async (taskId: string) => {
    if (!api) return;
    setBusyTaskId(taskId);
    try {
      setOutput(await api.getClaudeBackgroundTaskOutput(sessionId, taskId));
    } catch (err: any) {
      Alert.alert('출력 조회 실패', err?.message ?? '알 수 없는 오류');
    } finally {
      setBusyTaskId(null);
    }
  };

  const stopTask = async (taskId: string) => {
    if (!api) return;
    setBusyTaskId(taskId);
    try {
      await api.stopClaudeBackgroundTask(sessionId, taskId);
      await refresh();
    } catch (err: any) {
      Alert.alert('중단 실패', err?.message ?? '알 수 없는 오류');
    } finally {
      setBusyTaskId(null);
    }
  };

  if (tasks.length === 0 && !hasModeState && !loading && !recoveryNeeded) return null;

  return (
    <View testID="runtime-tasks-strip" style={styles.container}>
      <View style={styles.header}>
        <CompactTouchTarget
          testID="runtime-tasks-header-touch"
          onPress={() => setExpanded((value) => !value)}
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          frameStyle={styles.headerButton}
          surfaceStyle={styles.headerButtonSurface}
        >
          <DisclosureIcon
            expanded={expanded}
            color={t.colors.textMuted}
            size={t.iconSize.standard}
          />
          <Ionicons name="git-network-outline" color={t.colors.textMuted} size={t.iconSize.standard} />
          <Text style={styles.title} numberOfLines={1}>Claude Runtime Tasks</Text>
          {tasks.length > 0 || !recoveryNeeded ? (
            <Text style={styles.badge}>{tasks.length}</Text>
          ) : null}
          {recoveryNeeded ? <Text style={styles.errorBadge}>목록 미확인</Text> : null}
          {runningCount > 0 ? <Text style={styles.activeBadge}>{runningCount} active</Text> : null}
          {errorCount > 0 ? <Text style={styles.errorBadge}>{errorCount} error</Text> : null}
        </CompactTouchTarget>
        <CompactTouchTarget
          testID="runtime-tasks-refresh-touch"
          onPress={() => void refresh()}
          disabled={loading || !api}
          accessibilityLabel="백그라운드 작업 새로고침"
          surfaceStyle={styles.iconButton}
          surfaceTestID="runtime-tasks-refresh-visual"
        >
          {loading ? (
            <ActivityIndicator size="small" color={t.colors.textMuted} />
          ) : (
            <Ionicons name="refresh-outline" color={t.colors.textMuted} size={t.iconSize.standard} />
          )}
        </CompactTouchTarget>
      </View>
      {expanded ? (
        <ScrollView
          testID="runtime-tasks-details-scroll"
          style={styles.detailsScroll}
          contentContainerStyle={styles.detailsContent}
          nestedScrollEnabled
        >
          {hasModeState ? (
            <View style={styles.modeRow}>
              {planMode ? (
                <ModePill
                  icon="list-outline"
                  label={planMode.active ? 'Plan mode' : 'Plan off'}
                  active={planMode.active}
                  iconColor={planMode.active ? t.colors.warning : t.colors.textMuted}
                  styles={styles}
                />
              ) : null}
              {worktreeMode ? (
                <ModePill
                  icon="git-branch-outline"
                  label={worktreeLabel(worktreeMode)}
                  active={worktreeMode.active}
                  iconColor={worktreeMode.active ? t.colors.warning : t.colors.textMuted}
                  styles={styles}
                />
              ) : null}
            </View>
          ) : null}
          {tasks.map((task) => (
            <TaskRow
              key={task.taskId}
              task={task}
              busy={busyTaskId === task.taskId}
              styles={styles}
              tokenTextOnAccent={t.colors.accentText}
              onOpenOutput={() => void openOutput(task.taskId)}
              onStop={() => void stopTask(task.taskId)}
            />
          ))}
        </ScrollView>
      ) : null}
      <ClaudeRuntimeTaskOutputModal output={output} onClose={() => setOutput(null)} />
    </View>
  );
}

export function ClaudeRuntimeTaskOutputModal({ output, onClose }: {
  output: ClaudeRuntimeTaskOutputResponse | null; onClose(): void;
}) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);
  return (
      <AppModalSurface
        visible={output !== null}
        variant="expanded"
        modalId="modal_claude_runtime_tasks"
        presentationStyle="pageSheet"
        onRequestClose={onClose}
        surfaceTestID="runtime-output-modal"
      >
        <View style={styles.modalHeader}>
            <Text style={styles.modalTitle} numberOfLines={1}>
              {output?.taskId}
            </Text>
            <CompactTouchTarget
              testID="runtime-output-close-touch"
              onPress={onClose}
              accessibilityLabel="닫기"
              surfaceStyle={styles.iconButton}
            >
              <Ionicons name="close-outline" color={t.colors.textSecondary} size={t.iconSize.prominent} />
            </CompactTouchTarget>
        </View>
        <ScrollView style={styles.outputBody}>
            <Text style={styles.outputText}>
              {output?.output || output?.message || '출력이 없습니다'}
            </Text>
        </ScrollView>
      </AppModalSurface>
  );
}

function ModePill({
  icon,
  label,
  active,
  iconColor,
  styles,
}: {
  icon: React.ComponentProps<typeof Ionicons>['name'];
  label: string;
  active: boolean;
  iconColor: string;
  styles: ReturnType<typeof makeStyles>;
}) {
  return (
    <View style={[styles.modePill, active ? styles.modePillActive : styles.modePillInactive]}>
      <Ionicons name={icon} size={DESIGN_ICON_SIZE.compact} color={iconColor} />
      <Text
        style={[styles.modeText, active ? styles.modeTextActive : styles.modeTextInactive]}
        numberOfLines={1}
        ellipsizeMode="tail"
      >
        {label}
      </Text>
    </View>
  );
}

function worktreeLabel(mode: ClaudeRuntimeMode): string {
  if (!mode.active) {
    return mode.worktreeAction ? `Worktree off (${mode.worktreeAction})` : 'Worktree off';
  }
  return mode.worktreeName ?? mode.worktreePath ?? 'Worktree mode';
}

function TaskRow({
  task,
  busy,
  styles,
  tokenTextOnAccent,
  onOpenOutput,
  onStop,
}: {
  task: ClaudeRuntimeTask;
  busy: boolean;
  styles: ReturnType<typeof makeStyles>;
  tokenTextOnAccent: string;
  onOpenOutput: () => void;
  onStop: () => void;
}) {
  const terminal = TERMINAL_STATUSES.has(task.status);
  return (
    <View testID={`runtime-task-row-${task.taskId}`} style={styles.taskRow}>
      <View style={styles.taskText}>
        <View style={styles.taskTitleRow}>
          <Text style={[styles.status, statusStyle(task.status, styles)]}>
            {task.status}
          </Text>
          <Text style={styles.kind}>{taskKindLabel(task)}</Text>
          <Text style={styles.taskId} numberOfLines={1} ellipsizeMode="tail">
            {task.taskId}
          </Text>
        </View>
        <Text style={styles.summary} numberOfLines={1} ellipsizeMode="tail">
          {task.summary ?? task.subject ?? task.description ?? task.toolUseId ?? 'SDK task'}
        </Text>
      </View>
      <CompactTouchTarget
        testID={`runtime-task-output-touch-${task.taskId}`}
        onPress={onOpenOutput}
        disabled={busy}
        accessibilityLabel="출력 보기"
        surfaceStyle={styles.iconButton}
        surfaceTestID={`runtime-task-output-visual-${task.taskId}`}
      >
        {busy ? (
          <ActivityIndicator size="small" />
        ) : (
          <Ionicons name="document-text-outline" size={DESIGN_ICON_SIZE.standard} />
        )}
      </CompactTouchTarget>
      <CompactTouchTarget
        testID={`runtime-task-stop-touch-${task.taskId}`}
        onPress={onStop}
        disabled={busy || terminal}
        accessibilityLabel="작업 중단"
        frameStyle={(busy || terminal) && styles.buttonDisabled}
        surfaceStyle={styles.stopButton}
        surfaceTestID={`runtime-task-stop-visual-${task.taskId}`}
      >
        <Ionicons name="square-outline" color={tokenTextOnAccent} size={DESIGN_ICON_SIZE.compact} />
      </CompactTouchTarget>
    </View>
  );
}

function taskKindLabel(task: ClaudeRuntimeTask): string {
  if (task.taskType === 'bash' && task.isBackgrounded) return 'Background Bash';
  if (task.taskType === 'bash') return 'Bash';
  if (task.isBackgrounded) return 'Background Agent';
  if (task.taskType === 'agent') return 'Agent';
  if (task.subject) return 'SDK Task';
  return task.taskType ?? 'Task';
}

function statusStyle(
  status: ClaudeRuntimeTaskStatus,
  styles: ReturnType<typeof makeStyles>,
) {
  if (status === 'running' || status === 'pending') return styles.statusRunning;
  if (status === 'completed') return styles.statusCompleted;
  if (status === 'failed' || status === 'killed') return styles.statusFailed;
  return styles.statusStopped;
}

function makeStyles(t: DesignTokens) {
  const c = t.colors;
  const roles = createSurfaceRoles(t);
  return StyleSheet.create({
    container: {
      paddingHorizontal: t.uiSpacing.md,
      paddingVertical: 0,
      gap: t.uiSpacing.xs,
      backgroundColor: roles.chrome.tokenStyle.backgroundColor,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.uiSpacing.xs,
    },
    headerButton: {
      flex: 1,
    },
    headerButtonSurface: {
      width: '100%',
      minWidth: 0,
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.uiSpacing.xs,
    },
    title: {
      flex: 1,
      color: c.textSecondary,
      fontSize: t.fontSize.meta,
      fontWeight: '600',
    },
    badge: {
      textAlignVertical: 'center',
      overflow: 'hidden',
      borderRadius: 6,
      paddingHorizontal: t.uiSpacing.sm,
      paddingVertical: t.uiSpacing.xxs,
      color: c.textMuted,
      backgroundColor: c.surfaceMuted,
      fontSize: t.fontSize.meta,
      fontWeight: '700',
    },
    activeBadge: {
      textAlignVertical: 'center',
      overflow: 'hidden',
      borderRadius: 6,
      paddingHorizontal: t.uiSpacing.sm,
      paddingVertical: t.uiSpacing.xxs,
      color: c.textPrimary,
      backgroundColor: c.warningBg,
      fontSize: t.fontSize.meta,
      fontWeight: '700',
    },
    errorBadge: {
      textAlignVertical: 'center',
      overflow: 'hidden',
      borderRadius: 6,
      paddingHorizontal: t.uiSpacing.sm,
      paddingVertical: t.uiSpacing.xxs,
      color: c.textPrimary,
      backgroundColor: `${c.error}1A`,
      fontSize: t.fontSize.meta,
      fontWeight: '700',
    },
    detailsScroll: { maxHeight: RUNTIME_STRIP_DETAILS_MAX_HEIGHT },
    detailsContent: { gap: t.uiSpacing.xs },
    modeRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: t.uiSpacing.xs,
    },
    modePill: {
      maxWidth: '100%',
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.uiSpacing.xs,
      borderRadius: 4,
      paddingHorizontal: t.uiSpacing.sm,
      paddingVertical: t.uiSpacing.xxs,
    },
    modePillActive: {
      backgroundColor: c.warningBg,
    },
    modePillInactive: {
      backgroundColor: c.surfaceMuted,
    },
    modeText: {
      flexShrink: 1,
      minWidth: 0,
      fontSize: t.fontSize.meta,
      fontWeight: '700',
    },
    modeTextActive: { color: c.textPrimary },
    modeTextInactive: { color: c.textMuted },
    taskRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.uiSpacing.xs,
      borderRadius: t.radius.sm,
      paddingHorizontal: t.uiSpacing.sm,
      minHeight: t.foundation.minHeight.tool,
    },
    taskText: { flex: 1, minWidth: 0 },
    taskTitleRow: { flexDirection: 'row', alignItems: 'center', gap: t.uiSpacing.xs },
    taskId: {
      flex: 1,
      color: c.textMuted,
      fontSize: t.fontSize.meta,
      fontFamily: 'Menlo',
    },
    summary: {
      color: c.textSecondary,
      fontSize: t.fontSize.meta,
      marginTop: t.uiSpacing.xxs,
    },
    status: {
      textAlignVertical: 'center',
      overflow: 'hidden',
      borderRadius: 4,
      paddingHorizontal: t.uiSpacing.xs,
      paddingVertical: t.uiSpacing.xxs,
      fontSize: t.fontSize.meta,
      fontWeight: '700',
    },
    kind: {
      textAlignVertical: 'center',
      overflow: 'hidden',
      borderRadius: 4,
      paddingHorizontal: t.uiSpacing.xs,
      paddingVertical: t.uiSpacing.xxs,
      color: c.textMuted,
      backgroundColor: c.surfaceMuted,
      fontSize: t.fontSize.meta,
      fontWeight: '600',
    },
    statusRunning: { color: c.textPrimary, backgroundColor: `${c.success}1A` },
    statusCompleted: { color: c.textPrimary, backgroundColor: `${c.accent}1A` },
    statusFailed: { color: c.textPrimary, backgroundColor: `${c.error}1A` },
    statusStopped: { color: c.textMuted, backgroundColor: c.surfaceMuted },
    iconButton: {
      width: t.controlHeight.chip,
      height: t.controlHeight.chip,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: t.radius.lg,
    },
    stopButton: {
      width: t.controlHeight.chip,
      height: t.controlHeight.chip,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: t.radius.lg,
      backgroundColor: c.error,
    },
    buttonDisabled: { opacity: 0.45 },
    modalHeader: {
      minHeight: t.hitTarget.min + t.spacing.sm,
      paddingHorizontal: t.spacing.md,
      flexDirection: 'row',
      alignItems: 'center',
    },
    modalTitle: {
      flex: 1,
      color: c.textPrimary,
      fontSize: t.fontSize.screenTitle,
      fontWeight: '600',
    },
    outputBody: { flex: 1, padding: t.spacing.md },
    outputText: {
      color: c.textPrimary,
      fontSize: t.fontSize.body,
      lineHeight: t.fontSize.body * t.lineHeightRatio,
      fontFamily: 'Menlo',
    },
  });
}
