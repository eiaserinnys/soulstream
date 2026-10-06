import { useEffect, useMemo, useRef } from "react";
import { useDashboardStore, useSessionListProvider, useSessionMenu, type SessionSummary } from "@seosoyoung/soul-ui";
import { orchestratorSessionProvider } from "../providers";
import { OrchestratorSessionProvider } from "../providers/OrchestratorSessionProvider";
import type { FetchSessionsOptions } from "@seosoyoung/soul-ui";

// Only card history pages ID queries; the shared provider continues to resolve every requested ID.
export class CardHistorySessionProvider extends OrchestratorSessionProvider {
 async fetchSessions(options:FetchSessionsOptions={}) {
  const ids=options.sessionIds??[];
  const offset=options.offset??0;
  const result=await orchestratorSessionProvider.fetchSessions({...options,sessionIds:ids.slice(offset,options.limit?offset+options.limit:undefined)});
  return {...result,total:ids.length,hasMore:offset+result.sessions.length<ids.length};
 }
}
const cardHistoryProvider=new CardHistorySessionProvider();
import { buildRunTree, resolveRunSessions } from "./folder-workspace-run-model";
import { CardSessionVirtualList } from "@seosoyoung/soul-ui/cards/CardSessionVirtualList";
import { SessionRunList } from "./SessionRunList";

export interface CardSessionSelection {source:'automatic'|'user'}

export function CardSessionHistory({ sessionIds, onOpenSession, assigneeSessionId, initialSessionId }: {
  sessionIds: readonly string[];
  assigneeSessionId?: string | null;
  initialSessionId?: string | null;
  onOpenSession(session: SessionSummary, selection?:CardSessionSelection): void;
}) {
  const openMenu = useSessionMenu();
  const nextPage=useRef(false);
  // CardDetailPane keys this history by cardId: one initial choice per card opening.
  const sessionChosen = useRef(false);
  const catalog = useDashboardStore(state => state.catalog);
  const activeSessionId = useDashboardStore(state => state.activeSessionKey);
  // Reuse the folder history's ID query and query-cache lifecycle. The dashboard
  // already owns the catalog stream; opening a card does not need a second one.
  const targeted = useSessionListProvider({
    sessionIds, getSessionProvider: () => cardHistoryProvider,
    enabled: sessionIds.length > 0, streamEnabled: false,
    initialCatalogLoadEnabled: false, folderCountsEnabled: false,
  });
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
    if(!targeted.hasMore||nextPage.current)return;
    nextPage.current=true;
    void targeted.loadMore().finally(()=>{nextPage.current=false;});
  };
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
    <div className="v3-detail-section-head"><h3>세션</h3><span>{sessionIds.length}회</span></div>
    {sessionIds.length === 0 ? <p className="v3-detail-empty">아직 세션이 없습니다.</p> : null}
    {targeted.error?<p role="alert" className="v3-detail-empty">{targeted.error}</p>:null}
    <div className="v3-card-session-virtual" data-testid="card-session-virtual">
     <CardSessionVirtualList data={rows} style={{height:"100%"}} className="v3-session-panel-scroll" initialItemCount={1}
      computeItemKey={(_,row)=>row.node.session.agentSessionId} endReached={loadMore}
      itemContent={(_,row)=><div className={row.depth>0?"v3-run-children":undefined}><SessionRunList size="small" tree={[row.node]} activeSessionId={activeSessionId} onOpenSession={openSession} onContextMenu={(session,event)=>openMenu(session.agentSessionId,event)}/></div>}/>
    </div>
  </>;
}
