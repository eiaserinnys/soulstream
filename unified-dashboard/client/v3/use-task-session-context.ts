import { useMemo } from "react";

import type { CatalogFolder } from "@seosoyoung/soul-ui";
import type { BlockDto } from "@seosoyoung/soul-ui/page";

import { singleLinePreview } from "./session-preview";
import {
  buildPageContextSourcesMarker,
  mergeProjectContextPages,
} from "./project-context-inheritance";
import { parseProjectPageDetails } from "./project-page-details";
import { useProjectContextInheritance } from "./use-project-context-inheritance";
import type { PageSessionDefaults } from "./task-workspace-api";

/**
 * 업무 세션 생성에 필요한 컨텍스트 상속 파생값의 단일 정본.
 *
 * 상위 폴더 → 이 업무 순으로 컨텍스트를 병합해 succession 모달/컨텍스트 칩에
 * 넣을 `contextItems`, 배정 기본값(`effectiveSessionDefaults`), 페이지 컨텍스트
 * 소스 마커를 만든다. `TaskDetailPane`(업무 패널)과 `TaskBoardWorkspace`(보드
 * 세션 리스트의 새 세션 버튼)가 이 훅을 공유해 동일한 컨테이너 상속 경로를 쓴다.
 */
export function useTaskSessionContext({
  taskPageId,
  projectFolderId,
  folders,
  contextInvalidationKey,
  sessionDefaults,
  contextBlocks,
}: {
  taskPageId: string;
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
  const taskContext = useMemo(
    () => parseProjectPageDetails(contextBlocks),
    [contextBlocks],
  );
  const effectiveContext = useMemo(() => mergeProjectContextPages([
    ...(inheritedContext.status === "ready" ? inheritedContext.data.pages : []),
    {
      source: { folderId: taskPageId, folderName: "이 업무", pageId: taskPageId },
      details: taskContext,
    },
  ]), [inheritedContext, taskPageId, taskContext]);
  const contextItems = useMemo(() => [
    ...effectiveContext.guidance.map((guidance) => ({
      id: `${guidance.source.pageId}:${guidance.blockId}`,
      kind: "guidance" as const,
      blockId: guidance.blockId,
      direct: guidance.source.pageId === taskPageId,
      icon: "✦",
      contentLabel: singleLinePreview(guidance.text, 96) ?? guidance.text,
      sourceLabel: contextSourceLabel(guidance.source.folderName),
      label: `${singleLinePreview(guidance.text, 96) ?? guidance.text} · ${contextSourceLabel(guidance.source.folderName)}`,
    })),
    ...effectiveContext.atomReferences.map((reference) => ({
      id: `${reference.source.pageId}:${reference.blockId}`,
      kind: "atom" as const,
      blockId: reference.blockId,
      direct: reference.source.pageId === taskPageId,
      reference,
      icon: "⚛",
      contentLabel: reference.nodeTitle,
      sourceLabel: contextSourceLabel(reference.source.folderName),
      label: `${reference.nodeTitle} · ${contextSourceLabel(reference.source.folderName)}`,
    })),
    ...contextBlocks.flatMap((block) => {
      const match = /^\[\[([^\[\]]+)\]\]$/.exec(block.text.trim());
      return match ? [{
        id: block.id,
        kind: "page" as const,
        blockId: block.id,
        direct: true,
        icon: "📄",
        contentLabel: match[1],
        sourceLabel: "이 업무",
        label: `${match[1]} · 이 업무`,
      }] : [];
    }),
  ], [contextBlocks, effectiveContext, taskPageId]);
  const directDefaults = taskContext.sessionDefaults.at(-1) ?? null;
  const sourcedDefaults = effectiveContext.sessionDefaults.at(-1);
  const effectiveSessionDefaults = sourcedDefaults ? {
    agentId: sourcedDefaults.agentId,
    nodeId: sourcedDefaults.nodeId,
    sourcePageId: sourcedDefaults.source.pageId,
    sourceBlockId: sourcedDefaults.blockId,
  } : sessionDefaults;
  const assignmentSourceLabel = sourcedDefaults
    ? (sourcedDefaults.source.pageId === taskPageId
        ? "직접 지정"
        : `${sourcedDefaults.source.folderName}에서 상속`)
    : fallbackAssignmentSource(sessionDefaults, taskPageId, folders);
  const pageContextSources = buildPageContextSourcesMarker(
    inheritedContext.status === "ready"
      ? inheritedContext.data
      : mergeProjectContextPages([]),
    taskPageId,
  );

  return {
    inheritedContext,
    taskContext,
    effectiveContext,
    contextItems,
    directDefaults,
    effectiveSessionDefaults,
    assignmentSourceLabel,
    pageContextSources,
    contextPending: inheritedContext.status === "loading",
  };
}

export function contextSourceLabel(folderName: string): string {
  return folderName === "이 업무" ? folderName : `${folderName}에서 상속`;
}

export function fallbackAssignmentSource(
  defaults: PageSessionDefaults | null,
  taskPageId: string,
  folders: readonly CatalogFolder[],
): string {
  if (!defaults) return "미지정";
  if (defaults.sourcePageId === taskPageId) return "직접 지정";
  const source = folders.find((folder) => folder.projectPageId === defaults.sourcePageId);
  return source ? `${source.name}에서 상속` : "상위 컨텍스트에서 상속";
}
