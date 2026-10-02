import { useMemo } from "react";

import type { CatalogFolder } from "@seosoyoung/soul-ui";
import type { BlockDto } from "@seosoyoung/soul-ui/page";

import { buildFolderSessionContextItems } from "./folder-session-context-items";
export { contextSourceLabel } from "./folder-session-context-items";
import {
  mergeProjectContextPages,
} from "./project-context-inheritance";
import { parseProjectPageDetails } from "./project-page-details";
import { useProjectContextInheritance } from "./use-project-context-inheritance";
import type { PageSessionDefaults } from "./folder-workspace-page-api";

/**
 * 폴더 세션 생성에 필요한 컨텍스트 상속 파생값의 단일 정본.
 *
 * 상위 폴더 → 이 폴더 순으로 컨텍스트를 병합해 succession 모달/컨텍스트 칩에
 * 넣을 `contextItems`와 배정 기본값(`effectiveSessionDefaults`)을 만든다.
 * `FolderDetailPane`(폴더 패널)과 `FolderBoardWorkspace`(보드
 * 세션 리스트의 새 세션 버튼)가 이 훅을 공유해 동일한 컨테이너 상속 경로를 쓴다.
 */
export function useFolderSessionContext({
  folderPageId,
  projectFolderId,
  folders,
  contextInvalidationKey,
  sessionDefaults,
  contextBlocks,
}: {
  folderPageId: string;
  projectFolderId: string | null;
  folders: readonly CatalogFolder[];
  contextInvalidationKey: number;
  sessionDefaults: PageSessionDefaults | null;
  contextBlocks: readonly BlockDto[];
}) {
  const inheritedContext = useProjectContextInheritance({
    folderId: projectFolderId ?? "",
    folders,
    invalidationKey: contextInvalidationKey,
  });
  const folderContext = useMemo(
    () => parseProjectPageDetails(contextBlocks),
    [contextBlocks],
  );
  const effectiveContext = useMemo(() => mergeProjectContextPages([
    ...(inheritedContext.status === "ready" ? inheritedContext.data.pages : []),
    {
      source: { folderId: folderPageId, folderName: "이 폴더", pageId: folderPageId },
      details: folderContext,
    },
  ]), [inheritedContext, folderPageId, folderContext]);
  const contextItems = useMemo(() => buildFolderSessionContextItems(effectiveContext,contextBlocks,folderPageId),
    [contextBlocks,effectiveContext,folderPageId]);
  const directDefaults = folderContext.sessionDefaults.at(-1) ?? null;
  const sourcedDefaults = effectiveContext.sessionDefaults.at(-1);
  const effectiveSessionDefaults = sourcedDefaults ? {
    agentId: sourcedDefaults.agentId,
    nodeId: sourcedDefaults.nodeId,
    modelPreset: sourcedDefaults.modelPreset,
    sourcePageId: sourcedDefaults.source.pageId,
    sourceBlockId: sourcedDefaults.blockId,
  } : sessionDefaults;
  return {
    inheritedContext,
    folderContext,
    effectiveContext,
    contextItems,
    directDefaults,
    effectiveSessionDefaults,
    contextPending: inheritedContext.status === "loading",
  };
}
