import {useMemo} from "react";
import {useInfiniteQuery} from "@tanstack/react-query";
import {useDashboardStore,type SessionSummary} from "@seosoyoung/soul-ui";
import type {CardLinkedSession} from "@seosoyoung/soul-ui/cards/card-types";
import {dedupeSessionSnapshots,mergeSessionAssignmentsFromSummaries} from "@seosoyoung/soul-ui/hooks/session-stream-helpers";
import {orchestratorSessionProvider} from "../providers";
import {buildRunTree,resolveRunSessions,type RunTreeNode} from "./folder-workspace-run-model";

/** One complete newest-first order for requests, visible rows and stable numbers. */
export function orderCardSessionIds(ids:readonly string[],linked:readonly CardLinkedSession[],known:readonly SessionSummary[]) {
 const dates=new Map(known.map(session=>[session.agentSessionId,session.createdAt]));
 for(const session of linked)dates.set(session.sessionId,session.createdAt);
 const time=(id:string)=>Date.parse(dates.get(id)??"")||0;
 return [...new Set(ids)].sort((left,right)=>time(right)-time(left)||right.localeCompare(left));
}

/** The session stream owns existing summaries and assignments; a GET only fills absent IDs. */
function fillMissingCatalogSessions(sessions:readonly SessionSummary[],signal:AbortSignal) {
 signal.throwIfAborted();
 const store=useDashboardStore.getState();
 if(!store.catalog)return;
 const known=new Set([...Object.keys(store.catalog.sessions),...(store.catalog.sessionList??[]).map(session=>session.agentSessionId)]);
 const missing=sessions.filter(session=>!known.has(session.agentSessionId));
 if(missing.length===0)return;
 store.setCatalog(mergeSessionAssignmentsFromSummaries(store.catalog,missing));
}

/** Pages consume requested IDs, including inaccessible IDs, rather than returned row counts. */
export function useCardSessionPages(sessionIds:readonly string[],linkedSessions:readonly CardLinkedSession[]=[]) {
 const catalog=useDashboardStore(state=>state.catalog);
 const orderedIds=useMemo(()=>orderCardSessionIds(sessionIds,linkedSessions,catalog?.sessionList??[]),[sessionIds,linkedSessions,catalog?.sessionList]);
 const query=useInfiniteQuery({
  // Keep the shared SSE dimensions; the last dimension separates card pagination.
  queryKey:["sessions","ids",null,orderedIds,"card-history"],
  initialPageParam:0,
  queryFn:async({pageParam,signal})=>{
   const ids=orderedIds.slice(pageParam,pageParam+50);
   const result=await orchestratorSessionProvider.fetchSessions({sessionIds:ids,signal});
   fillMissingCatalogSessions(result.sessions,signal);
   const processed=pageParam+ids.length;
   return {...result,nextOffset:processed<orderedIds.length?processed:undefined};
  },
  getNextPageParam:last=>last.nextOffset,
  enabled:orderedIds.length>0,
  staleTime:Infinity,
 });
 const sessions=useMemo(()=>dedupeSessionSnapshots(query.data?.pages.flatMap(page=>page.sessions)??[]),[query.data]);
 return {sessions,loading:query.isFetching,hasMore:query.hasNextPage,loadMore:query.fetchNextPage,error:query.error?.message};
}

/** Reuse folder hierarchy, then apply the full card order even when a failed row is present. */
export function projectCardSessionHistory(sessionIds:readonly string[],linkedSessions:readonly CardLinkedSession[],catalogSessions:readonly SessionSummary[],targeted:{sessions:readonly SessionSummary[];loading:boolean;hasMore?:boolean}) {
 const orderedIds=orderCardSessionIds(sessionIds,linkedSessions,catalogSessions);
 const catalogIds=new Set(catalogSessions.map(session=>session.agentSessionId));
 const resolved=resolveRunSessions({sessionIds:orderedIds,catalogSessions,targetedSessions:targeted.sessions.filter(session=>!catalogIds.has(session.agentSessionId)),targetedLoading:targeted.loading});
 const rank=new Map(orderedIds.map((id,index)=>[id,index]));
 const project=(nodes:RunTreeNode[],root:boolean):RunTreeNode[]=>nodes.map(node=>({...node,
  runNumber:root?orderedIds.length-rank.get(node.session.agentSessionId)!:null,
  children:project(node.children,false),
 })).sort((left,right)=>rank.get(left.session.agentSessionId)!-rank.get(right.session.agentSessionId)!);
 const tree=project(buildRunTree(orderedIds,resolved.sessions,targeted.hasMore?undefined:resolved.loadStateById),true);
 return {...resolved,tree};
}
