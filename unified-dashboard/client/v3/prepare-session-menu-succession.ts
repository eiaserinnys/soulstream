import type { useTranslation } from "react-i18next";
import type { CatalogState, SessionSummary } from "@seosoyoung/soul-ui";
import { folderProjectContextSources, mergeProjectContextPages } from "./project-context-inheritance";
import { fetchProjectPageDetails } from "./project-page-details";
import { buildFolderSessionContextItems } from "./folder-session-context-items";
import { fetchFolderBoardItems } from "./folder-inline-board-api";
import { boardMarkdownDocuments } from "./folder-inline-board-model";

type Translate = ReturnType<typeof useTranslation>["t"];

/** Resolve inherited defaults before mounting the existing form's initial state. */
export async function prepareSessionMenuSuccession(session:SessionSummary,folderId:string|null,catalog:CatalogState|null, t: Translate) {
  const folder = catalog?.folders.find(folder=>folder.id===folderId);
  const sources = folderProjectContextSources(folderId ?? "",catalog?.folders ?? []);
  if (sources.status === "unavailable") throw new Error(t("sessions.folderInfoMissing"));
  const pages = await Promise.all(sources.sources.map(async source=>({
    source: source.folderId === folderId ? {...source, folderName:"이 폴더"} : source, // i18n-ignore: sentinel matched by contextSourceLabel
    snapshot:await fetchProjectPageDetails(source.pageId),
  })));
  const merged = mergeProjectContextPages(pages.map(({source,snapshot})=>({source,details:snapshot})));
  const pageId = folder?.projectPageId ?? "";
  const blocks = pages.find(page=>page.source.pageId===pageId)?.snapshot.blocks ?? [];
  const defaults = merged.sessionDefaults.at(-1);
  return {
    folderTitle:folder?.name ?? t("sessions.session"),folderId,folderPageId:pageId,currentSession:session,
    predecessorOptions:[{sessionId:session.agentSessionId,label:session.displayName ?? null,runNumber:null}],
    contextItems:buildFolderSessionContextItems(merged,blocks,pageId,t),
    documentOptions: folderId
      ? boardMarkdownDocuments(await fetchFolderBoardItems(folderId))
        .map(document=>({pageId:document.pageId,title:document.title}))
      : [],
    pageDefaults:defaults ? {
      agentId:defaults.agentId,nodeId:defaults.nodeId,modelPreset:defaults.modelPreset,
      sourcePageId:defaults.source.pageId,sourceBlockId:defaults.blockId,
    } : null,
  };
}
