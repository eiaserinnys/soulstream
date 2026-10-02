import type { CatalogState, SessionSummary } from "@seosoyoung/soul-ui";
import { folderProjectContextSources, mergeProjectContextPages } from "./project-context-inheritance";
import { fetchProjectPageDetails } from "./project-page-details";
import { buildFolderSessionContextItems } from "./folder-session-context-items";

/** Resolve inherited defaults before mounting the existing form's initial state. */
export async function prepareSessionMenuSuccession(session:SessionSummary,folderId:string|null,catalog:CatalogState|null) {
  const folder = catalog?.folders.find(folder=>folder.id===folderId);
  const sources = folderProjectContextSources(folderId ?? "",catalog?.folders ?? []);
  if (sources.status === "unavailable") throw new Error("세션의 폴더 정보를 찾을 수 없습니다.");
  const pages = await Promise.all(sources.sources.map(async source=>({
    source: source.folderId === folderId ? {...source, folderName:"이 폴더"} : source,
    snapshot:await fetchProjectPageDetails(source.pageId),
  })));
  const merged = mergeProjectContextPages(pages.map(({source,snapshot})=>({source,details:snapshot})));
  const pageId = folder?.projectPageId ?? "";
  const blocks = pages.find(page=>page.source.pageId===pageId)?.snapshot.blocks ?? [];
  const defaults = merged.sessionDefaults.at(-1);
  return {
    folderTitle:folder?.name ?? "세션",folderId,folderPageId:pageId,currentSession:session,
    predecessorOptions:[{sessionId:session.agentSessionId,label:session.displayName ?? "제목 없는 세션",runNumber:null}],
    contextItems:buildFolderSessionContextItems(merged,blocks,pageId),
    documentOptions:(catalog?.boardItems ?? []).filter(item=>item.folderId===folderId && item.itemType==="markdown")
      .map(item=>({pageId:item.itemId,title:typeof item.metadata?.title==="string"?item.metadata.title:"문서"})),
    pageDefaults:defaults ? {
      agentId:defaults.agentId,nodeId:defaults.nodeId,modelPreset:defaults.modelPreset,
      sourcePageId:defaults.source.pageId,sourceBlockId:defaults.blockId,
    } : null,
  };
}
