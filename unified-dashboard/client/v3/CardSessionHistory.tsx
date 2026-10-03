import { useEffect, useMemo, useRef, useState } from "react";
import { useDashboardStore, useSessionListProvider, useSessionMenu, type SessionSummary } from "@seosoyoung/soul-ui";
import { orchestratorSessionProvider } from "../providers";
import { buildRunTree, resolveRunSessions } from "./folder-workspace-run-model";
import { SessionRunList } from "./SessionRunList";

export function CardSessionHistory({ sessionIds, onOpenSession, collapsedLimit, assigneeSessionId }: {
  sessionIds: readonly string[];
  collapsedLimit?: number;
  assigneeSessionId?: string | null;
  onOpenSession(session: SessionSummary): void;
}) {
  const openMenu = useSessionMenu();
  const [expanded,setExpanded] = useState(false);
  // CardDetailPane keys this history by cardId: one initial choice per card opening.
  const sessionChosen = useRef(false);
  const catalog = useDashboardStore(state => state.catalog);
  const activeSessionId = useDashboardStore(state => state.activeSessionKey);
  // Reuse the folder history's ID query and query-cache lifecycle. The dashboard
  // already owns the catalog stream; opening a card does not need a second one.
  const targeted = useSessionListProvider({
    sessionIds, getSessionProvider: () => orchestratorSessionProvider,
    enabled: sessionIds.length > 0, streamEnabled: false,
    initialCatalogLoadEnabled: false, folderCountsEnabled: false,
  });
  const resolved = useMemo(() => resolveRunSessions({
      sessionIds, catalogSessions: catalog?.sessionList ?? [],
      targetedSessions: targeted.sessions, targetedLoading: targeted.loading,
    }), [catalog?.sessionList, sessionIds, targeted.sessions, targeted.loading]);
  const tree = useMemo(() => buildRunTree(sessionIds, resolved.sessions, resolved.loadStateById), [sessionIds, resolved]);
  useEffect(() => {
    if (sessionChosen.current || !assigneeSessionId) return;
    const assignee = resolved.sessions.find(session => session.agentSessionId === assigneeSessionId);
    if (!assignee) return;
    sessionChosen.current = true;
    onOpenSession(assignee);
  }, [assigneeSessionId, resolved.sessions, onOpenSession]);
  const openSession = (session: SessionSummary) => {
    sessionChosen.current = true;
    onOpenSession(session);
  };
  let remaining = collapsedLimit ?? Infinity;
  const trim = (nodes: typeof tree): typeof tree => nodes.flatMap(node => {
    if (remaining <= 0) return [];
    remaining--;
    return [{...node,children:trim(node.children)}];
  });
  const visibleTree = expanded ? tree : trim(tree);
  return <>
    <div className="v3-detail-section-head"><h3>세션</h3><span>{sessionIds.length}회</span></div>
    {sessionIds.length === 0 ? <p className="v3-detail-empty">아직 세션이 없습니다.</p> : null}
    <SessionRunList size="small" tree={visibleTree} activeSessionId={activeSessionId} onOpenSession={openSession} onContextMenu={(session,event)=>openMenu(session.agentSessionId,event)} />
    {!expanded && collapsedLimit && sessionIds.length > collapsedLimit ? <button type="button" className="v3-card-more" onClick={()=>setExpanded(true)}>{sessionIds.length-collapsedLimit}개 더</button> : null}
  </>;
}
