import { useEffect, useMemo, useState } from "react";
import {
  DashboardIconCap,
  retainEqualValue,
  type CatalogFolder,
  type SessionSummary,
} from "@seosoyoung/soul-ui";
import { createPageApiClient, type PageDto } from "@seosoyoung/soul-ui/page";
import { ChevronsDown, FolderPlus } from "lucide-react";

import { PlannerFolderCard } from "./PlannerFolderCard";
import { ProjectContextEditor } from "./ProjectContextEditor";
import { fetchProjectPageDetails, type ProjectPageSnapshot } from "./project-page-details";
import { loadConfirmedResult } from "./planner-query-state";
import type { PlannerFolder } from "./planner-data";
import type { SessionNodeConnectivity } from "./session-node-connectivity";
import { V3ErrorNotice } from "./V3ErrorNotice";
import { plannerEntryForFolder } from "./folder-workspace-model";

export function FolderWorkspaceSections({
  folder,
  parentFolder,
  children,
  hasMoreChildren,
  childrenLoadingMore,
  onLoadMoreChildren,
  knownPages,
  sessions,
  nodeConnectivity,
  todayFolderIds,
  invalidationKey,
  onOpenFolder,
  onCreateSubfolder,
  onRenameChild,
  onArchiveChild,
  onCompleteFolder,
  onToggleFolderToday,
  onMoveFolderToParent,
  onBlocksChanged,
}: {
  folder: CatalogFolder;
  parentFolder: CatalogFolder | null;
  children: readonly CatalogFolder[];
  hasMoreChildren: boolean;
  childrenLoadingMore: boolean;
  onLoadMoreChildren(): void;
  knownPages: readonly PageDto[];
  sessions: readonly SessionSummary[];
  nodeConnectivity: SessionNodeConnectivity;
  todayFolderIds: ReadonlySet<string>;
  invalidationKey: number;
  onOpenFolder(folder: CatalogFolder): void;
  onCreateSubfolder(): void;
  onRenameChild(folder: CatalogFolder): void;
  onArchiveChild(folder: CatalogFolder): void;
  onCompleteFolder(task: PlannerFolder): Promise<void>;
  onToggleFolderToday(task: PlannerFolder): Promise<void>;
  onMoveFolderToParent(task: PlannerFolder): void;
  onBlocksChanged(blocks: PlannerFolder["blocks"]): void;
}) {
  const api = useMemo(() => createPageApiClient(), []);
  const [details, setDetails] = useState<{
    status: "loading" | "ready" | "error";
    data: ProjectPageSnapshot | null;
    message: string | null;
  }>({ status: "loading", data: null, message: null });
  const [cardPages, setCardPages] = useState<Record<string, PageDto>>({});
  const pageId = folder.projectPageId;

  const refreshDetails = async () => {
    if (!pageId) return;
    const loaded = await loadConfirmedResult({
      previous: details.data,
      load: () => fetchProjectPageDetails(pageId),
      clearsVisibleContent: (current, next) => current.blocks.length > 0 && next.blocks.length === 0,
    });
    setDetails((current) => retainEqualValue(current, { status: "ready", data: loaded, message: null }));
    onBlocksChanged(loaded.blocks);
  };

  useEffect(() => {
    if (!pageId) return;
    let active = true;
    setDetails({ status: "loading", data: null, message: null });
    void fetchProjectPageDetails(pageId).then((loaded) => {
      if (active) setDetails({ status: "ready", data: loaded, message: null });
    }).catch((error: unknown) => {
      if (active) setDetails({ status: "error", data: null, message: errorText(error) });
    });
    return () => { active = false; };
  }, [pageId, invalidationKey]);

  useEffect(() => {
    let active = true;
    const missing = [...(parentFolder ? [parentFolder] : []), ...children].filter((item) => item.projectPageId
      && !knownPages.some((page) => page.id === item.projectPageId));
    void Promise.all(missing.map(async (item) => {
      const snapshot = await api.getPage(item.projectPageId!);
      return [item.id, snapshot.page] as const;
    })).then((entries) => {
      if (active) setCardPages((current) => ({ ...current, ...Object.fromEntries(entries) }));
    }).catch((error: unknown) => {
      console.error("[v3/folder] 하위 폴더 페이지 조회 실패", error);
    });
    return () => { active = false; };
  }, [api, children, knownPages, parentFolder]);

  const childTasks = children.map((child) => {
    const page = knownPages.find((candidate) => candidate.id === child.projectPageId)
      ?? cardPages[child.id];
    if (!page) return null;
    return { folder: child, task: plannerEntryForFolder(child, { ...page, title: child.name }, pageId ?? null) };
  }).filter((entry): entry is { folder: CatalogFolder; task: PlannerFolder } => entry !== null);
  const parentPage = parentFolder && (knownPages.find((candidate) => candidate.id === parentFolder.projectPageId)
    ?? cardPages[parentFolder.id]);
  const parentTask = parentFolder && parentPage
    ? plannerEntryForFolder(parentFolder, { ...parentPage, title: parentFolder.name }, parentFolder.parentFolderId ?? null)
    : null;

  return (
    <>
      {details.status === "ready" && details.data && pageId ? (
        <ProjectContextEditor pageId={pageId} snapshot={details.data} onChanged={refreshDetails} />
      ) : details.status === "loading" ? (
        <section className="v3-project-context" aria-busy="true">프로젝트 컨텍스트를 불러오는 중…</section>
      ) : details.status === "error" ? (
        <V3ErrorNotice className="v3-project-context v3-project-star-error" message="프로젝트 컨텍스트를 불러오지 못했습니다." detail={details.message} />
      ) : null}

      <section className="v3-child-folders">
        <div className="v3-section-head">
          <h2>하위 폴더</h2><span>{children.length}개</span>
          <span className="v3-spacer" />
          <DashboardIconCap size="small" label="새 폴더" onClick={onCreateSubfolder}>
            <FolderPlus className="h-4 w-4" aria-hidden="true" />
          </DashboardIconCap>
        </div>
        <div className="v3-task-list">
          {parentFolder && parentTask ? <div data-testid={`v3-parent-folder-${parentFolder.id}`}>
            <PlannerFolderCard
              task={parentTask}
              navigationLabel="상위 폴더"
              sessions={sessions}
              nodeConnectivity={nodeConnectivity}
              isInToday={todayFolderIds.has(parentTask.page.id)}
              onOpen={() => onOpenFolder(parentFolder)}
              onComplete={() => onCompleteFolder(parentTask)}
              onToggleToday={() => onToggleFolderToday(parentTask)}
              onMoveToParent={() => onMoveFolderToParent(parentTask)}
            />
          </div> : null}
          {childTasks.map(({ folder: child, task }) => <div key={child.id} data-testid={`v3-child-folder-${child.id}`}>
            <PlannerFolderCard
              task={task}
              sessions={sessions}
              nodeConnectivity={nodeConnectivity}
              isInToday={todayFolderIds.has(task.page.id)}
              onOpen={() => onOpenFolder(child)}
              onComplete={() => onCompleteFolder(task)}
              onToggleToday={() => onToggleFolderToday(task)}
              onMoveToParent={() => onMoveFolderToParent(task)}
              onRename={() => onRenameChild(child)}
              onArchive={() => onArchiveChild(child)}
            />
          </div>)}
        </div>
        {hasMoreChildren ? <DashboardIconCap label="하위 폴더 더 보기" disabled={childrenLoadingMore} onClick={onLoadMoreChildren}>
          <ChevronsDown className="h-4 w-4" aria-hidden="true" />
        </DashboardIconCap> : null}
      </section>
    </>
  );
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}
