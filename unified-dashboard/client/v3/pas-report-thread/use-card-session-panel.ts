import { useCallback, useEffect, useMemo, useState } from "react";
import { createChatSessionStore, useAuth, useDashboardStore, useSessionProvider, type SessionReviewAcknowledgeResult, type SessionSummary } from "@seosoyoung/soul-ui";
import { useCardStore } from "@seosoyoung/soul-ui/cards/card-store";
import { orchestratorSessionProvider } from "../../providers";
import { useSessionNodeConnectivity } from "../use-session-node-connectivity";
import { resolveSessionForOpen } from "../v3-session-workspace";
import type { CardSessionSelection } from "../CardSessionHistory";

type Selection = { cardId: string; sessionId: string };
const noop = () => undefined;

/**
 * 보고 창 위 카드 패널의 오른쪽 칸(세션)을 PAS 화면 카드 패널과 같은 동작으로 잇는다.
 * 세션 행을 누르면 새 탭이 아니라 오른쪽 칸에 그 세션이 열린다. 패널을 닫으면 선택은 사라진다.
 * 카드의 담당 세션이 PAS 자신의 세션이면 PAS 화면의 대화를 그대로 쓰고 따로 스트림을 열지 않는다.
 * `enabled`가 false면(견본) 스트림과 세션 조회를 하지 않는다.
 *
 * 이 로직은 PersistentSessionScreen.tsx의 카드 패널 오른쪽 칸(overlaySession* 묶음)을 따라 한 사본이다.
 * 한쪽을 고치면 다른 쪽도 같이 맞춘다.
 */
export function useCardSessionPanel({ cardId, ownSessionId, enabled }: { cardId: string | null; ownSessionId: string | null; enabled: boolean }) {
  const { user, refreshAuthStatus } = useAuth();
  const onConnectionError = useCallback(() => { void refreshAuthStatus().catch(() => undefined); }, [refreshAuthStatus]);
  const cursorScope = `${window.location.origin}|${user?.email ?? "anonymous"}`;
  const { nodes } = useSessionNodeConnectivity();
  const catalog = useDashboardStore(state => state.catalog);
  const activeSessionKey = useDashboardStore(state => state.activeSessionKey);
  const activeSessionSummary = useDashboardStore(state => state.activeSessionSummary);
  const card = useCardStore(state => cardId ? state.byId[cardId] : undefined);
  const assignedSessionId = card?.assigneeKind === "session" ? card.assigneeSessionId : null;
  const [selection, setSelection] = useState<Selection | null>(null);
  const [resolved, setResolved] = useState<SessionSummary | null>(null);
  const sessionId = selection?.cardId === cardId ? selection.sessionId : assignedSessionId;
  const own = sessionId !== null && sessionId === ownSessionId;

  const storeScope = useMemo(() => enabled && sessionId && !own ? createChatSessionStore(sessionId) : null, [enabled, own, sessionId]);
  const idleScope = useMemo(() => createChatSessionStore(null), []);
  const catalogSession = sessionId ? catalog?.sessionList?.find(session => session.agentSessionId === sessionId) : undefined;
  const known = own && activeSessionSummary?.agentSessionId === sessionId ? activeSessionSummary : catalogSession;
  const activeSession = resolved?.agentSessionId === sessionId ? resolved : known;
  const ownsStream = Boolean(enabled && cardId && sessionId && !own);
  const stream = useSessionProvider({
    sessionKey: ownsStream ? sessionId : null,
    store: (storeScope ?? idleScope).store,
    active: ownsStream,
    getSessionProvider: () => orchestratorSessionProvider,
    cursorScope,
    onConnectionError,
  });
  const nodeId = activeSession?.nodeId;
  const chatInputDisabled = !enabled || !nodeId || nodes.get(nodeId)?.status !== "connected";

  useEffect(() => {
    if (!enabled || !cardId || !sessionId) { setResolved(null); return; }
    let current = true;
    if (known) { setResolved(known); return () => { current = false; }; }
    setResolved(null);
    void resolveSessionForOpen({ sessionId, fetchSessions: orchestratorSessionProvider.fetchSessions })
      .then(summary => { if (current) setResolved(summary); })
      .catch(() => { if (current) setResolved(null); });
    return () => { current = false; };
  }, [cardId, enabled, known, sessionId]);
  useEffect(() => {
    if (!storeScope || !activeSession || activeSession.agentSessionId !== sessionId) return;
    storeScope.store.getState().setActiveSessionSummary(activeSession);
  }, [activeSession, sessionId, storeScope]);

  const openSession = useCallback((summary: SessionSummary, _selection?: CardSessionSelection) => {
    if (!cardId) return;
    setSelection({ cardId, sessionId: summary.agentSessionId });
    setResolved(summary);
  }, [cardId]);
  const continueSession = useCallback((nextSessionId: string) => {
    if (!cardId) return;
    setSelection({ cardId, sessionId: nextSessionId });
    setResolved(null);
  }, [cardId]);
  const acknowledgeReview = useCallback((result: SessionReviewAcknowledgeResult) => {
    const current = resolved?.agentSessionId === result.agentSessionId ? resolved
      : activeSessionSummary?.agentSessionId === result.agentSessionId ? activeSessionSummary : catalogSession;
    if (current) setResolved({ ...current, reviewState: result.reviewState });
    if (ownSessionId === result.agentSessionId) {
      const state = useDashboardStore.getState();
      if (state.activeSessionSummary?.agentSessionId === result.agentSessionId) state.setActiveSessionSummary({ ...state.activeSessionSummary, reviewState: result.reviewState });
    }
    const scoped = storeScope?.store.getState();
    if (scoped?.activeSessionSummary?.agentSessionId === result.agentSessionId) scoped.setActiveSessionSummary({ ...scoped.activeSessionSummary, reviewState: result.reviewState });
  }, [activeSessionSummary, catalogSession, ownSessionId, resolved, storeScope]);

  const ownLive = own && activeSessionKey === sessionId;
  return {
    workspaceProps: {
      initialSessionId: sessionId,
      onOpenSession: openSession,
      activeSession,
      storeScope: own ? undefined : storeScope ?? undefined,
      onSessionChange: continueSession,
      chatInputDisabled,
      fileUploadUrl: !chatInputDisabled && nodeId ? `/api/attachments/sessions?nodeId=${encodeURIComponent(nodeId)}` : undefined,
      // PersistentSessionScreen과 같다. PAS 자신의 세션은 화면의 대화 저장소가 이미 이력을 들고 있어 여기서 이력 버퍼를 또 만들지 않는다.
      historyEnabled: own ? false : Boolean(sessionId && stream.synchronizedSessionKey === sessionId),
      loadDisplaySettings: !own,
      sessionStreamActive: own ? ownLive : Boolean(sessionId && stream.status === "connected"),
      sessionConnectionStatus: own ? ("connected" as const) : sessionId ? stream.status : ("disconnected" as const),
      reconnectSession: own ? noop : stream.reconnect,
      onAcknowledgedReview: acknowledgeReview,
    },
  };
}
