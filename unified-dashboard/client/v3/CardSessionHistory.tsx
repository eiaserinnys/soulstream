import { useMemo, useState } from "react";
import { useDashboardStore, useSessionListProvider, useSessionMenu, type SessionSummary } from "@seosoyoung/soul-ui";
import { orchestratorSessionProvider } from "../providers";
import { buildRunTree, resolveRunSessions } from "./folder-workspace-run-model";
import { SessionRunList } from "./SessionRunList";

export function CardSessionHistory({ sessionIds, onOpenSession, collapsedLimit }: {
  sessionIds: readonly string[];
  collapsedLimit?: number;
  onOpenSession(session: SessionSummary): void;
}) {
  const openMenu = useSessionMenu();
  const [expanded,setExpanded] = useState(false);
  const catalog = useDashboardStore(state => state.catalog);
  const activeSessionId = useDashboardStore(state => state.activeSessionKey);
  // Reuse the folder history's ID query and query-cache lifecycle. The dashboard
  // already owns the catalog stream; opening a card does not need a second one.
  const targeted = useSessionListProvider({
    sessionIds, getSessionProvider: () => orchestratorSessionProvider,
    enabled: sessionIds.length > 0, streamEnabled: false,
    initialCatalogLoadEnabled: false, folderCountsEnabled: false,
  });
  const tree = useMemo(() => {
    const resolved = resolveRunSessions({
      sessionIds, catalogSessions: catalog?.sessionList ?? [],
      targetedSessions: targeted.sessions, targetedLoading: targeted.loading,
    });
    return buildRunTree(sessionIds, resolved.sessions, resolved.loadStateById);
  }, [catalog?.sessionList, sessionIds, targeted.sessions, targeted.loading]);
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
    <SessionRunList size="small" tree={visibleTree} activeSessionId={activeSessionId} onOpenSession={onOpenSession} onContextMenu={(session,event)=>openMenu(session.agentSessionId,event)} />
    {!expanded && collapsedLimit && sessionIds.length > collapsedLimit ? <button type="button" className="v3-card-more" onClick={()=>setExpanded(true)}>{sessionIds.length-collapsedLimit}개 더</button> : null}
  </>;
}
