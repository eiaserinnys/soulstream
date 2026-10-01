import React, { useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import type { ApiClient } from '../../api/client';
import type { PlannerFolder } from '../../api/plannerTypes';
import { usePlannerActions } from '../../hooks/usePlannerActions';
import { readLastPlannerSessionDefaults } from '../../lib/planner-context-presentation';
import { buildPlannerFolderContextItem } from '../../lib/planner-session-context';
import {
  buildSessionStartDiagnosticContextItem,
  clearSessionSuccessionFailure,
  type SessionSuccessionFailureRecord,
} from '../../lib/session-succession-diagnostics';
import { useSettingsStore } from '../../store/settingsStore';
import { useTokens, type DesignTokens } from '../../theme';
import { AppModalSurface } from '../AppModalSurface';

export const DIAGNOSTIC_SESSION_PROMPT =
  '새 세션 시작 오류를 진단해 주세요. 첨부된 구조화 진단 컨텍스트와 연결된 업무를 우선 확인해 원인을 찾아주세요.';

type DiagnosticTargetSource = 'task-defaults' | 'predecessor' | 'task-session';

interface DiagnosticTarget {
  nodeId: string;
  agentId: string;
  modelPreset?: string;
  source: DiagnosticTargetSource;
}

export function SessionSuccessionDiagnosticFallback({
  api,
  folder,
  predecessorSessionId,
  visible,
  onClose,
  onCreated,
  failure,
}: {
  api: ApiClient | null;
  folder: PlannerFolder;
  predecessorSessionId: string | null;
  visible: boolean;
  onClose(): void;
  onCreated(sessionId: string): void;
  failure: SessionSuccessionFailureRecord;
}) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);
  const actions = usePlannerActions(api);
  const settingsNodeId = useSettingsStore((state) => state.nodeId);
  const target = resolveDiagnosticSessionTarget(folder, predecessorSessionId, settingsNodeId);
  const inFlight = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const visibleError = submitError ?? (target
    ? null
    : '진단 세션에 사용할 노드와 에이전트를 폴더에서 찾지 못했습니다.');

  const submit = async () => {
    if (inFlight.current) return;
    if (!target) {
      setSubmitError('진단 세션에 사용할 노드와 에이전트를 폴더에서 찾지 못했습니다.');
      return;
    }
    inFlight.current = true;
    setSubmitting(true);
    setSubmitError(null);
    let created = false;
    try {
      const response = await actions.createFolderSession({
        folder: folder,
        prompt: DIAGNOSTIC_SESSION_PROMPT,
        nodeId: target.nodeId,
        agentId: target.agentId,
        ...(target.modelPreset ? { modelPreset: target.modelPreset } : {}),
        needsPageAnchor: true,
        extraContextItems: [
          buildPlannerFolderContextItem(folder),
          buildSessionStartDiagnosticContextItem(failure, {
            targetSource: target.source,
            targetNodeId: target.nodeId,
            targetAgentId: target.agentId,
            settingsNodeId: normalized(settingsNodeId),
          }),
        ],
      });
      if (!response.agentSessionId) throw new Error('세션 생성 응답에 ID가 없습니다.');
      await clearSessionSuccessionFailure(failure.diagnosticId);
      created = true;
      onCreated(response.agentSessionId);
      onClose();
    } catch (error) {
      setSubmitError(errorText(error));
    } finally {
      inFlight.current = false;
      if (!created) setSubmitting(false);
    }
  };

  const canSubmit = Boolean(target && !submitting);
  return (
    <AppModalSurface
      visible={visible}
      variant="expanded"
      modalId="modal_session_succession_diagnostic"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
      safeAreaTestID="succession-diagnostic-safe-area"
    >
      <View testID="succession-diagnostic-fallback" style={styles.page}>
        <View style={styles.header}>
          <TouchableOpacity style={styles.headerButton} onPress={onClose}>
            <Text style={styles.headerAction}>닫기</Text>
          </TouchableOpacity>
          <Text style={styles.title}>새 세션 시작 실패</Text>
          <View style={styles.headerButton} />
        </View>

        <View style={styles.content}>
          <Text style={styles.heading}>오류 정보를 진단 세션에 연결할 수 있습니다.</Text>
          <Text style={styles.body}>
            예외와 앱·기기 상태를 이 폴더의 새 진단 세션 첫 컨텍스트로 보냅니다.
            정상 새 세션 설정은 다시 읽지 않습니다.
          </Text>
          <View style={styles.details}>
            <Text style={styles.meta}>폴더 · {folder.page.title}</Text>
            <Text style={styles.meta}>발생 시각 · {failure.occurredAt}</Text>
            <Text style={styles.errorSummary} numberOfLines={3}>{failure.error.message}</Text>
          </View>
          {visibleError ? (
            <View style={styles.failureNotice}>
              <Text style={styles.failureTitle}>진단 세션을 만들지 못했습니다.</Text>
              <Text style={styles.failureText}>{visibleError}</Text>
            </View>
          ) : null}
          <TouchableOpacity
            testID="succession-diagnostic-submit"
            accessibilityRole="button"
            accessibilityState={{ disabled: !canSubmit }}
            disabled={!canSubmit}
            style={[styles.primaryButton, !canSubmit && styles.disabledButton]}
            onPress={submit}
          >
            {submitting
              ? <ActivityIndicator color={t.colors.accentText} />
              : <Text style={styles.primaryText}>{submitError ? '다시 시도' : '진단 세션 만들기'}</Text>}
          </TouchableOpacity>
        </View>
      </View>
    </AppModalSurface>
  );
}

export function resolveDiagnosticSessionTarget(
  folder: PlannerFolder,
  predecessorSessionId: string | null,
  settingsNodeId: string | null | undefined,
): DiagnosticTarget | null {
  const defaults = readLastPlannerSessionDefaults(folder.blocks);
  const explicitPredecessor = predecessorSessionId
    ? folder.sessions.find((session) => session.agentSessionId === predecessorSessionId)
    : undefined;
  const priorSession = explicitPredecessor ?? [...folder.sessions].reverse().find((session) => (
    normalized(session.agentId) && normalized(session.nodeId)
  ));
  const agentId = defaults?.agentId ?? normalized(priorSession?.agentId);
  const nodeId = defaults?.nodeId
    ?? normalized(priorSession?.nodeId)
    ?? normalized(settingsNodeId);
  const modelPreset =
    defaults?.modelPreset ?? normalized(priorSession?.modelPreset);
  if (!agentId || !nodeId) return null;
  return {
    agentId,
    nodeId,
    ...(modelPreset ? { modelPreset } : {}),
    source: defaults
      ? 'task-defaults'
      : explicitPredecessor
        ? 'predecessor'
        : 'task-session',
  };
}

function normalized(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function makeStyles(t: DesignTokens) {
  return StyleSheet.create({
    page: { flex: 1 },
    header: {
      minHeight: t.hitTarget.min + t.spacing.sm,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: t.foundation.pageInset,
    },
    headerButton: {
      width: 64,
      minHeight: t.hitTarget.min,
      justifyContent: 'center',
    },
    headerAction: { color: t.colors.accent, ...t.foundation.typography.body, fontWeight: '700' },
    title: { color: t.colors.textPrimary, ...t.foundation.typography.navigation },
    content: {
      flex: 1,
      paddingHorizontal: t.foundation.pageInset,
      paddingVertical: t.spacing.xl,
      gap: t.spacing.lg,
      justifyContent: 'center',
    },
    heading: { color: t.colors.textPrimary, ...t.foundation.typography.section },
    body: { color: t.colors.textSecondary, ...t.foundation.typography.body },
    details: { gap: t.spacing.xs },
    meta: { color: t.colors.textTertiary, ...t.foundation.typography.meta },
    errorSummary: { color: t.colors.textSecondary, ...t.foundation.typography.meta },
    failureNotice: { gap: t.spacing.xs },
    failureTitle: { color: t.colors.danger, ...t.foundation.typography.label },
    failureText: { color: t.colors.textSecondary, ...t.foundation.typography.meta },
    primaryButton: {
      minHeight: t.foundation.minHeight.field,
      borderRadius: t.foundation.radius.field,
      backgroundColor: t.colors.accent,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: t.spacing.md,
    },
    disabledButton: { opacity: 0.45 },
    primaryText: { color: t.colors.accentText, ...t.foundation.typography.body, fontWeight: '700' },
  });
}
