import { folderErrorText } from "./folder-messages";
import { useTranslation } from "react-i18next";
import { useEffect, useMemo, useState } from "react";
import {
  DashboardIconCap,
  FrameLoading,
  retainEqualValue,
  type CatalogFolder,
  type SessionSummary,
} from "@seosoyoung/soul-ui";
import type { PageDto } from "../../../packages/page-model/src/types";
import { createPageApiClient } from "@seosoyoung/soul-ui/page";
import { ChevronsDown, FolderPlus } from "lucide-react";

import { PlannerFolderCard } from "./PlannerFolderCard";
import { ProjectContextEditor } from "./ProjectContextEditor";
import { fetchProjectPageDetails, type ProjectPageSnapshot } from "./project-page-details";
import { loadConfirmedResult } from "./planner-query-state";
import type { PlannerFolder } from "./planner-data";
import type { SessionNodeConnectivity } from "@seosoyoung/soul-ui/lib/session-node-connectivity";
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
  invalidationKey,
  onOpenFolder,
  onCreateSubfolder,
  onRenameChild,
  onArchiveChild,
  onCompleteFolder,
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
  invalidationKey: number;
  onOpenFolder(folder: CatalogFolder): void;
  onCreateSubfolder(): void;
  onRenameChild(folder: CatalogFolder): void;
  onArchiveChild(folder: CatalogFolder): void;
  onCompleteFolder(task: PlannerFolder): Promise<void>;
  onMoveFolderToParent(task: PlannerFolder): void;
  onBlocksChanged(blocks: PlannerFolder["blocks"]): void;
}) {
  const { t, i18n } = useTranslation();
  const number = new Intl.NumberFormat(i18n.resolvedLanguage);
  const api = useMemo(() => createPageApiClient(), []);
  const [details, setDetails] = useState<{
    status: "loading" | "ready" | "error";
    data: ProjectPageSnapshot | null;
    error: unknown;
  }>({ status: "loading", data: null, error: null });
  const [cardPages, setCardPages] = useState<Record<string, PageDto>>({});
  const pageId = folder.projectPageId;

  const refreshDetails = async () => {
    if (!pageId) return;
    const loaded = await loadConfirmedResult({
      previous: details.data,
      load: () => fetchProjectPageDetails(pageId),
      clearsVisibleContent: (current, next) => current.blocks.length > 0 && next.blocks.length === 0,
    });
    setDetails((current) => retainEqualValue(current, { status: "ready", data: loaded, error: null }));
    onBlocksChanged(loaded.blocks);
  };

  useEffect(() => {
    if (!pageId) return;
    let active = true;
    setDetails({ status: "loading", data: null, error: null });
    void fetchProjectPageDetails(pageId).then((loaded) => {
      if (active) setDetails({ status: "ready", data: loaded, error: null });
    }).catch((error: unknown) => {
      if (active) setDetails({ status: "error", data: null, error });
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
      console.error("[v3/folder] 하위 폴더 페이지 조회 실패", error); // i18n-ignore: Diagnostic log for subfolder reads
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
        <section className="v3-project-context" aria-busy="true"><FrameLoading inline label={t("folders.context.loading")} /></section>
      ) : details.status === "error" ? (
        <V3ErrorNotice className="v3-project-context v3-project-star-error" message={t("folders.context.loadError")} detail={folderErrorText(t, details.error)} />
      ) : null}

      <section className="v3-child-folders">
        <div className="v3-section-head">
          <h2>{t("folders.workspace.subfolders")}</h2><span>{t("folders.common.itemCount", { total: number.format(children.length) })}</span>
          <span className="v3-spacer" />
          <DashboardIconCap size="small" label={t("folders.common.newFolder")} onClick={onCreateSubfolder}>
            <FolderPlus className="h-4 w-4" aria-hidden="true" />
          </DashboardIconCap>
        </div>
        <div className="v3-task-list">
          {parentFolder && parentTask ? <div data-testid={`v3-parent-folder-${parentFolder.id}`}>
            <PlannerFolderCard
              task={parentTask}
              navigationLabel={t("folders.workspace.parentFolder")}
              sessions={sessions}
              nodeConnectivity={nodeConnectivity}
              onOpen={() => onOpenFolder(parentFolder)}
              onComplete={() => onCompleteFolder(parentTask)}
              onMoveToParent={() => onMoveFolderToParent(parentTask)}
            />
          </div> : null}
          {childTasks.map(({ folder: child, task }) => <div key={child.id} data-testid={`v3-child-folder-${child.id}`}>
            <PlannerFolderCard
              task={task}
              sessions={sessions}
              nodeConnectivity={nodeConnectivity}
              onOpen={() => onOpenFolder(child)}
              onComplete={() => onCompleteFolder(task)}
              onMoveToParent={() => onMoveFolderToParent(task)}
              onRename={() => onRenameChild(child)}
              onArchive={() => onArchiveChild(child)}
            />
          </div>)}
        </div>
        {hasMoreChildren ? <DashboardIconCap label={t("folders.workspace.moreSubfolders")} disabled={childrenLoadingMore} onClick={onLoadMoreChildren}>
          <ChevronsDown className="h-4 w-4" aria-hidden="true" />
        </DashboardIconCap> : null}
      </section>
    </>
  );
}
