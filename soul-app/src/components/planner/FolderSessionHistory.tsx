import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import type { ApiClient } from '../../api/client';
import type { PlannerSessionSummary } from '../../api/plannerTypes';
import type { Session } from '../../api/types';
import { usePlannerFolderSessions } from '../../hooks/usePlannerReads';
import { buildPlannerSessionTreeRows } from '../../lib/planner-session-tree';
import {
  isSessionStoreScopeCurrent,
  useSessionStore,
} from '../../store/sessionStore';
import { useNodeConnectivityStore } from '../../store/nodeConnectivityStore';
import { createPlannerVisualRoles, useTokens, type DesignTokens } from '../../theme';
import { SessionCard } from '../SessionCard';
import { AppGlassCard } from '../AppGlassCard';
import { captureAuthScope, useAuthScopeGeneration } from '../../lib/auth-scope';
import { projectVisibleSessions } from '../../lib/session-node-projection';

type SessionDetailStatus = 'loading' | 'error';

export function FolderSessionHistory({
  api,
  folderId = null,
  sessionIds: explicitSessionIds,
  small = false,
  active = true,
  sessionSummaries = [],
  onOpenSession,
  onLongPressSession,
}: {
  api: ApiClient | null;
  folderId?: string | null;
  sessionIds?: readonly string[];
  small?: boolean;
  active?: boolean;
  sessionSummaries?: readonly PlannerSessionSummary[];
  onOpenSession?: (sessionId: string) => void;
  onLongPressSession?: (sessionId: string) => void;
}) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);
  const scopeGeneration = useAuthScopeGeneration();
  const { data, loading, error, loadMore } = usePlannerFolderSessions(
    api,
    folderId,
    active && !!folderId && !explicitSessionIds,
  );
  const catalogSessions = useSessionStore((state) => state.sessions);
  const nodesReady = useNodeConnectivityStore((state) => state.ready);
  const connectedNodeIds = useNodeConnectivityStore((state) => state.connectedNodeIds);
  const sessionIds = useMemo(() => [...new Set(explicitSessionIds ?? [
    ...(data?.items ?? []).map((run) => run.agentSessionId),
    ...sessionSummaries.map((summary) => summary.agentSessionId),
  ])], [data?.items, explicitSessionIds, sessionSummaries]);
  const missingSessionIds = useMemo(() => (
    sessionIds.filter((sessionId) => !catalogSessions[sessionId])
  ), [catalogSessions, sessionIds]);
  const missingSessionKey = missingSessionIds.join('\u0000');
  const [detailStatusById, setDetailStatusById] = useState<Record<string, SessionDetailStatus>>({});
  const [detailOwner, setDetailOwner] = useState(scopeGeneration);
  const requestSerial = useRef(0);
  const requestBySessionId = useRef<Record<string, number>>({});
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    requestSerial.current += 1;
    requestBySessionId.current = {};
    setDetailOwner(scopeGeneration);
    setDetailStatusById({});
  }, [scopeGeneration]);
  const loadSessionDetails = useCallback((sessionIdsToLoad: readonly string[]) => {
    if (!api || !active || sessionIdsToLoad.length === 0) return;
    const requestedIds = [...new Set(sessionIdsToLoad)];
    const requestId = ++requestSerial.current;
    const requestScopeGeneration = scopeGeneration;
    requestedIds.forEach((sessionId) => { requestBySessionId.current[sessionId] = requestId; });
    setDetailStatusById((current) => {
      const next = { ...current };
      requestedIds.forEach((sessionId) => { next[sessionId] = 'loading'; });
      return next;
    });
    void api.getSessionsByIds(requestedIds)
      .then((sessions) => {
        if (
          !mounted.current
          || captureAuthScope().generation !== requestScopeGeneration
          || !isSessionStoreScopeCurrent(requestScopeGeneration)
        ) return;
        const currentSessions = sessions.filter((session) => (
          requestBySessionId.current[session.agentSessionId] === requestId
        ));
        useSessionStore.getState().mergeSessions(currentSessions);
        const storedSessions = useSessionStore.getState().sessions;
        setDetailStatusById((current) => {
          const next = { ...current };
          requestedIds.forEach((sessionId) => {
            if (requestBySessionId.current[sessionId] !== requestId) return;
            if (storedSessions[sessionId]) delete next[sessionId];
            else next[sessionId] = 'error';
          });
          return next;
        });
      })
      .catch(() => {
        if (
          !mounted.current
          || captureAuthScope().generation !== requestScopeGeneration
          || !isSessionStoreScopeCurrent(requestScopeGeneration)
        ) return;
        setDetailStatusById((current) => {
          const next = { ...current };
          requestedIds.forEach((sessionId) => {
            if (requestBySessionId.current[sessionId] === requestId) next[sessionId] = 'error';
          });
          return next;
        });
      });
  }, [active, api, scopeGeneration]);
  useEffect(() => {
    loadSessionDetails(missingSessionIds);
    // 배열 identity가 아니라 ID 집합 변화에만 반응한다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadSessionDetails, missingSessionKey]);
  const summariesById = useMemo(
    () => new Map(sessionSummaries.map((summary) => [summary.agentSessionId, summary])),
    [sessionSummaries],
  );
  const rows = useMemo(() => buildPlannerSessionTreeRows(
    projectVisibleSessions(sessionIds.map((sessionId) => resolveFolderRunSession(
      sessionId,
      summariesById.get(sessionId),
      catalogSessions[sessionId],
    )), {
      ready: nodesReady,
      connectedNodeIds,
    }),
  ), [catalogSessions, connectedNodeIds, nodesReady, sessionIds, summariesById]);
  const visibleDetailStatusById = detailOwner === scopeGeneration ? detailStatusById : {};
  if (!folderId && !explicitSessionIds) return null;
  return (
    <View testID="task-run-history-list" style={styles.container}>
      {rows.map(({ session, depth }) => {
        const detailStatus = api && !catalogSessions[session.agentSessionId]
          ? visibleDetailStatusById[session.agentSessionId] ?? 'loading'
          : null;
        return (
          <View
            key={session.agentSessionId}
            testID={`task-run-depth-${session.agentSessionId}`}
            style={{ marginLeft: depth * t.spacing.md }}
          >
            {detailStatus ? (
              <AppGlassCard
                testID={`task-run-detail-${detailStatus}-${session.agentSessionId}`}
                style={styles.detailState}
              >
                <Text style={styles.detailTitle} numberOfLines={1}>
                  {session.displayName?.trim() || '세션 정보'}
                </Text>
                <View style={styles.detailStateRow}>
                  {detailStatus === 'loading' ? (
                    <>
                      <ActivityIndicator size="small" color={t.colors.accent} />
                      <Text style={styles.detailMessage}>세션 상세를 불러오는 중입니다.</Text>
                    </>
                  ) : (
                    <>
                      <Text style={styles.error}>세션 상세를 불러오지 못했습니다.</Text>
                      <TouchableOpacity
                        testID={`task-run-detail-retry-${session.agentSessionId}`}
                        style={styles.retryAction}
                        onPress={() => loadSessionDetails([session.agentSessionId])}
                      >
                        <Text style={styles.more}>다시 시도</Text>
                      </TouchableOpacity>
                    </>
                  )}
                </View>
              </AppGlassCard>
            ) : (
              <SessionCard
                session={session}
                onPress={() => onOpenSession?.(session.agentSessionId)}
                onLongPress={() => onLongPressSession?.(session.agentSessionId)}
                testID={`task-run-row-${session.agentSessionId}`}
                surfaceTestID={`task-run-surface-${session.agentSessionId}`}
                avatarTestID={`task-run-avatar-${session.agentSessionId}`}
                timeTestID={`task-run-time-${session.agentSessionId}`}
                embedded
                small={small || undefined}
              />
            )}
          </View>
        );
      })}
      {!explicitSessionIds && loading ? <ActivityIndicator color={t.colors.accent} /> : null}
      {!explicitSessionIds && error ? <Text style={styles.error}>{error}</Text> : null}
      {!explicitSessionIds && data?.nextCursor && !loading ? (
        <TouchableOpacity style={styles.moreAction} onPress={loadMore}>
          <Text style={styles.more}>더 보기</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

export function resolveFolderRunSession(
  sessionId: string,
  plannerSummary: PlannerSessionSummary | undefined,
  catalogSession: Session | undefined,
): Session {
  const plannerSession = plannerSummaryToSession(sessionId, plannerSummary);
  return catalogSession ? {
    ...plannerSession,
    ...catalogSession,
    displayName: catalogSession.displayName?.trim()
      ? catalogSession.displayName
      : plannerSummary?.displayName ?? catalogSession.displayName,
    status: catalogSession.status || plannerSession.status,
    createdAt: catalogSession.createdAt || plannerSession.createdAt,
    updatedAt: catalogSession.updatedAt || plannerSession.updatedAt,
  } : plannerSession;
}

export function plannerSummaryToSession(
  sessionId: string,
  summary?: PlannerSessionSummary,
): Session {
  return {
    agentSessionId: sessionId,
    displayName: summary?.displayName ?? null,
    status: summary?.status ?? 'unknown',
    createdAt: summary?.createdAt ?? '',
    updatedAt: summary?.updatedAt ?? summary?.createdAt ?? '',
    folderId: summary?.folderId ?? null,
    nodeId: summary?.nodeId ?? undefined,
    sessionType: summary?.sessionType ?? undefined,
    agentId: summary?.agentId ?? undefined,
    callerSessionId: summary?.callerSessionId ?? null,
    reviewState: summary?.reviewState === 'needs_review'
      || summary?.reviewState === 'acknowledged'
      ? summary.reviewState
      : 'not_required',
    reviewRequired: summary?.reviewState === 'needs_review',
  };
}

function makeStyles(t: DesignTokens) {
  const planner = createPlannerVisualRoles(t);
  return StyleSheet.create({
    container: { gap: t.cardLayout.gap },
    error: { color: t.colors.errorText, ...planner.typography.meta },
    detailState: {
      minHeight: planner.minHeight.row,
      padding: t.cardLayout.padding,
      gap: t.uiSpacing.sm,
    },
    detailTitle: {
      color: t.colors.textPrimary,
      ...planner.typography.cardTitle,
    },
    detailStateRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: t.uiSpacing.sm,
    },
    detailMessage: { color: t.colors.textSecondary, ...planner.typography.meta, flex: 1 },
    retryAction: {
      minWidth: planner.actionColumn,
      minHeight: planner.actionColumn,
      alignItems: 'flex-end',
      justifyContent: 'center',
    },
    more: { color: t.colors.accent, ...planner.typography.label, paddingVertical: t.spacing.xs },
    moreAction: {
      minWidth: planner.actionColumn,
      minHeight: planner.actionColumn,
      justifyContent: 'center',
    },
  });
}
