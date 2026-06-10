import { useCallback, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useDashboardStore,
  type SessionSummary,
} from "@seosoyoung/soul-ui";
import { useAppConfig } from "../config/AppConfigContext";
import {
  buildContinueSessionPrompt,
  resolveContinueSessionTarget,
} from "client/lib/continue-session";
import { createDashboardSession } from "client/lib/session-create";

export function useContinueSession(sessions: SessionSummary[] | undefined) {
  const queryClient = useQueryClient();
  const appConfig = useAppConfig();
  const catalog = useDashboardStore((s) => s.catalog);
  const dashboardConfig = useDashboardStore((s) => s.dashboardConfig);
  const activeSessionSummary = useDashboardStore((s) => s.activeSessionSummary);
  const addOptimisticSession = useDashboardStore((s) => s.addOptimisticSession);

  const lookupSessions = useMemo(() => {
    const byId = new Map<string, SessionSummary>();
    for (const session of catalog?.sessionList ?? []) byId.set(session.agentSessionId, session);
    for (const session of sessions ?? []) byId.set(session.agentSessionId, session);
    if (activeSessionSummary) byId.set(activeSessionSummary.agentSessionId, activeSessionSummary);
    return byId;
  }, [activeSessionSummary, catalog?.sessionList, sessions]);

  const resolveTarget = useCallback(
    (sessionId: string) => {
      return resolveContinueSessionTarget({
        session: lookupSessions.get(sessionId),
        catalog,
        agents: dashboardConfig?.agents ?? [],
        mode: appConfig.mode,
        localNodeId: appConfig.nodeId,
      });
    },
    [appConfig.mode, appConfig.nodeId, catalog, dashboardConfig?.agents, lookupSessions],
  );

  const getContinueSessionDisabledReason = useCallback(
    (sessionId: string) => resolveTarget(sessionId).disabledReason,
    [resolveTarget],
  );

  const continueSession = useCallback(
    async (sessionId: string) => {
      const target = resolveTarget(sessionId);
      if (target.disabledReason) {
        throw new Error(target.disabledReason);
      }
      await createDashboardSession({
        queryClient,
        addOptimisticSession,
        prompt: buildContinueSessionPrompt(sessionId),
        folderId: target.folderId,
        nodeId: target.nodeId,
        agentId: target.agentId,
        agent: {
          id: target.agentId,
          name: target.agentName,
          portraitUrl: target.agentPortraitUrl,
          backend: target.backend,
        },
      });
    },
    [addOptimisticSession, queryClient, resolveTarget],
  );

  return {
    continueSession,
    getContinueSessionDisabledReason,
  };
}
