import {useMemo} from "react";
import {useInfiniteQuery} from "@tanstack/react-query";
import {useDashboardStore} from "@seosoyoung/soul-ui";
import {dedupeSessionSnapshots,mergeSessionAssignmentsFromSummaries} from "@seosoyoung/soul-ui/hooks/session-stream-helpers";
import {orchestratorSessionProvider} from "../providers";

/** Card pages consume IDs, including deleted IDs; the generic list consumes returned rows. */
export function useCardSessionPages(orderedIds:readonly string[]) {
 const query=useInfiniteQuery({
  // Retain the shared sessions/ids dimensions so catalog SSE still updates these pages.
  queryKey:["sessions","ids",null,orderedIds,"card-history"],
  initialPageParam:0,
  queryFn:async({pageParam})=>{
   const ids=orderedIds.slice(pageParam,pageParam+50);
   const result=await orchestratorSessionProvider.fetchSessions({sessionIds:ids});
   const store=useDashboardStore.getState();
   if(store.catalog){
    const catalog=mergeSessionAssignmentsFromSummaries(store.catalog,result.sessions);
    if(catalog!==store.catalog)store.setCatalog(catalog);
   }
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
