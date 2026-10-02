import { useEffect, useMemo, useState } from "react";
import { useDashboardStore, type SessionSummary } from "@seosoyoung/soul-ui";
import { SessionSuccessionModal } from "./SessionSuccessionModal";
import { useFolderSessionContext } from "./use-folder-session-context";
import { fetchProjectPageDetails, type ProjectPageSnapshot } from "./project-page-details";

export function SessionMenuSuccession({session,folderId,onClose,onCreated}: {
  session:SessionSummary;folderId:string|null;onClose():void;onCreated(session:SessionSummary):void;
}) {
  const catalog = useDashboardStore(state=>state.catalog);
  const folders = catalog?.folders ?? [];
  const folder = folders.find(folder=>folder.id===folderId);
  const pageId = folder?.projectPageId ?? "";
  const [page,setPage] = useState<ProjectPageSnapshot|null>(null);
  const [error,setError] = useState<string|null>(null);
  useEffect(()=>{
    if (!pageId) return;
    let active=true;
    void fetchProjectPageDetails(pageId).then(value=>{if(active)setPage(value);},
      error=>{if(active)setError(error instanceof Error?error.message:String(error));});
    return ()=>{active=false;};
  },[pageId]);
  const context = useFolderSessionContext({
    folderPageId:pageId,projectFolderId:folderId,folders,contextInvalidationKey:0,
    sessionDefaults:null,contextBlocks:page?.blocks ?? [],
  });
  const documents = useMemo(()=>(catalog?.boardItems ?? [])
    .filter(item=>item.folderId===folderId && item.itemType==="markdown")
    .map(item=>({pageId:item.itemId,title:typeof item.metadata?.title==="string"?item.metadata.title:"문서"})),
    [catalog?.boardItems,folderId]);
  return <SessionSuccessionModal folderTitle={folder?.name ?? "세션"} folderPageId={pageId}
    folderId={folderId} currentSession={session}
    predecessorOptions={[{sessionId:session.agentSessionId,label:session.displayName ?? "제목 없는 세션",runNumber:null}]}
    contextItems={context.contextItems} documentOptions={documents}
    contextPending={Boolean(pageId && !page && !error) || Boolean(folderId && context.contextPending)}
    contextError={error} pageDefaults={context.effectiveSessionDefaults}
    onClose={onClose} onCreated={onCreated} />;
}
