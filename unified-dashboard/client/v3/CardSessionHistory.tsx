import { useEffect, useMemo, useRef } from "react";
import { useDashboardStore, useSessionMenu, type SessionSummary } from "@seosoyoung/soul-ui";
import type {CardLinkedSession} from "@seosoyoung/soul-ui/cards/card-types";
import {useCardSessionPages} from "./useCardSessionPages";
import { buildRunTree, resolveRunSessions } from "./folder-workspace-run-model";
import { CardSessionVirtualList } from "@seosoyoung/soul-ui/cards/CardSessionVirtualList";
import { SessionRunList } from "./SessionRunList";

export interface CardSessionSelection {source:'automatic'|'user'}

export function CardSessionHistory({ sessionIds, linkedSessions=[], onOpenSession, assigneeSessionId, initialSessionId }: {
  sessionIds: readonly string[];
  linkedSessions?:readonly CardLinkedSession[];
  assigneeSessionId?: string | null;
  initialSessionId?: string | null;
  onOpenSession(session: SessionSummary, selection?:CardSessionSelection): void;
}) {
  const openMenu = useSessionMenu();
  // CardDetailPane keys this history by cardId: one initial choice per card opening.
  const sessionChosen = useRef(false);
  const catalog = useDashboardStore(state => state.catalog);
  const activeSessionId = useDashboardStore(state => state.activeSessionKey);
  const orderedIds=useMemo(()=>{
    const dates=new Map((catalog?.sessionList??[]).map(session=>[session.agentSessionId,session.createdAt]));
    for(const session of linkedSessions)dates.set(session.sessionId,session.createdAt);
    const time=(id:string)=>Date.parse(dates.get(id)??"")||0;
    return [...new Set(sessionIds)].sort((left,right)=>time(right)-time(left)||right.localeCompare(left));
  },[sessionIds,linkedSessions,catalog?.sessionList]);
  const targeted=useCardSessionPages(orderedIds);
  const resolved = useMemo(() => resolveRunSessions({
      sessionIds, catalogSessions: catalog?.sessionList ?? [],
      targetedSessions: targeted.sessions, targetedLoading: targeted.loading,
  }), [catalog?.sessionList, sessionIds, targeted.sessions, targeted.loading]);
  const tree = useMemo(() => buildRunTree(sessionIds, resolved.sessions, targeted.hasMore?undefined:resolved.loadStateById), [sessionIds, resolved,targeted.hasMore]);
  const rows=useMemo(()=>{
    const result:{node:(typeof tree)[number];depth:number}[]=[];
    const append=(nodes:typeof tree,depth:number)=>{for(const node of nodes){result.push({node:{...node,children:[]},depth});append(node.children,depth+1);}};
    append(tree,0);return result;
  },[tree]);
  const loadMore=()=>{
    if(targeted.hasMore&&!targeted.loading)void targeted.loadMore({cancelRefetch:false});
  };
  useEffect(()=>{
    // Children can arrive before their parent; an empty projection must still page forward.
    if(rows.length===0&&!targeted.loading&&!targeted.error)loadMore();
  },[rows.length,targeted.loading,targeted.hasMore,targeted.error,targeted.loadMore]);
  useEffect(() => {
    if (sessionChosen.current) return;
    const preferredSessionId = initialSessionId ?? assigneeSessionId;
    if (!preferredSessionId) return;
    const preferred = resolved.sessions.find(session => session.agentSessionId === preferredSessionId);
    if (!preferred) return;
    sessionChosen.current = true;
    onOpenSession(preferred,{source:'automatic'});
  }, [assigneeSessionId, initialSessionId, resolved.sessions, onOpenSession]);
  const openSession = (session: SessionSummary) => {
    sessionChosen.current = true;
    onOpenSession(session,{source:'user'});
  };
  return <>
    {sessionIds.length === 0 ? <p className="v3-detail-empty">아직 세션이 없습니다.</p> : null}
    {targeted.error?<p role="alert" className="v3-detail-empty">{targeted.error}</p>:null}
    <div className="v3-card-session-virtual" data-testid="card-session-virtual" role="region" aria-label="카드 세션 목록">
     <CardSessionVirtualList data={rows} style={{height:"100%"}} className="v3-session-panel-scroll" initialItemCount={1}
      computeItemKey={(_,row)=>row.node.session.agentSessionId} endReached={loadMore}
      itemContent={(_,row)=>Array.from({length:row.depth}).reduce<import("react").ReactNode>(child=><div className="v3-run-children">{child}</div>,<SessionRunList size="small" tree={[row.node]} activeSessionId={activeSessionId} onOpenSession={openSession} onContextMenu={(session,event)=>openMenu(session.agentSessionId,event)}/>)}/>
    </div>
  </>;
}
