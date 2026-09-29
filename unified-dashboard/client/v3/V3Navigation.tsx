import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import {
  Button,
  DashboardDndProvider,
  DashboardIconCap,
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
  isSystemFolderId,
  readFolderTreeExpandedState,
  reorderStarredFolderIds,
  StarredFolderSortableContext,
  pointerFirstCollisionDetection,
  useStarredFolderDragSurface,
  useGlassSurface,
  writeFolderTreeExpandedState,
  type CatalogFolder,
  type CatalogFolderReorderItem,
} from "@seosoyoung/soul-ui";
import { ChevronsDown, FolderPlus, GripVertical } from "lucide-react";
import { createPageApiClient } from "@seosoyoung/soul-ui/page";

import { ProjectDialog, type ProjectDialogTarget } from "./ProjectDialog";
import { ProjectNavigationTree } from "./ProjectNavigationTree";
import { saveProjectFormContext } from "./project-form-actions";
import { setFolderStarred } from "./folder-star-actions";
import {
  clearFolderStarChange,
  publishFolderStarChange,
  folderStarredState,
  useFolderStarChanges,
} from "./folder-star-store";
import { V3ContextMenu, type V3ContextMenuTarget } from "./V3ContextMenu";
import {
  buildProjectContextMenuActions,
  buildFolderContextMenuActions,
} from "./context-menu-model";
import { starredFolderPage, type StarredPlannerFolder } from "./planner-data";
import "./v3-project-star.css";

export interface PlannerDateNavItem {
  date: string;
  label: string;
}

type MenuState =
  | { target: V3ContextMenuTarget; kind: "starred_folder"; task: StarredPlannerFolder }
  | { target: V3ContextMenuTarget; kind: "folder"; folder: CatalogFolder };

export function V3Navigation({
  dates,
  selectedDate,
  folders,
  catalogLoadError = null,
  selectedFolderId,
  starredFolders,
  starredFoldersHasMore,
  starredFoldersLoading,
  todayFolderIds,
  completedFolderIds,
  onLoadMoreStarredFolders,
  onReorderStarredFolders,
  onSelectDate,
  onSelectFolder,
  onSelectStarredFolder,
  onCompleteFolder,
  onToggleFolderToday,
  onMoveFolderToParent,
  onCreateProject,
  onRenameProject,
  onDeleteProject,
  onReorderProjects,
  projectHasContents,
  onCreateFolder,
}: {
  dates: readonly PlannerDateNavItem[];
  selectedDate: string;
  folders: readonly CatalogFolder[];
  catalogLoadError?: string | null;
  selectedFolderId: string | null;
  starredFolders: readonly StarredPlannerFolder[];
  starredFoldersHasMore: boolean;
  starredFoldersLoading: boolean;
  todayFolderIds: ReadonlySet<string>;
  completedFolderIds: ReadonlySet<string>;
  onLoadMoreStarredFolders(): void;
  onReorderStarredFolders(movedPageId: string, orderedPageIds: readonly string[]): Promise<void>;
  onSelectDate(date: string): void;
  onSelectFolder(folder: CatalogFolder): void;
  onSelectStarredFolder(folder: StarredPlannerFolder): void;
  onCompleteFolder(task: StarredPlannerFolder): Promise<void>;
  onToggleFolderToday(task: StarredPlannerFolder): Promise<void>;
  onMoveFolderToParent(task: StarredPlannerFolder): void;
  onCreateProject(title: string, parentFolderId: string | null): Promise<CatalogFolder>;
  onRenameProject(folder: CatalogFolder, title: string): Promise<void>;
  onDeleteProject(folder: CatalogFolder): Promise<void>;
  onReorderProjects(items: CatalogFolderReorderItem[]): Promise<void>;
  projectHasContents(folderId: string): boolean;
  onCreateFolder(folderId: string): void;
}) {
  const surfaceRef = useRef<HTMLElement>(null);
  const webglActive = useGlassSurface(surfaceRef, { enabled: true });
  const api = useMemo(() => createPageApiClient(), []);
  const folderStarChanges = useFolderStarChanges();
  const visibleFolders = useMemo(() => folders.filter((folder) => !folder.archived), [folders]);
  const [projectDialog, setProjectDialog] = useState<ProjectDialogTarget | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<CatalogFolder | null>(null);
  const [expandedFolders, setExpandedFolders] = useState<Record<string, boolean>>({});
  const [pendingFolderId, setPendingFolderId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<MenuState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const starredFolderIds = useMemo(
    () => starredFolders.map((task) => starredFolderPage(task).id),
    [starredFolders],
  );

  const storage = typeof window === "undefined" ? undefined : window.localStorage;
  const isProjectExpanded = useCallback((folderId: string) => (
    expandedFolders[folderId] ?? readFolderTreeExpandedState(storage, folderId)
  ), [expandedFolders, storage]);
  const setProjectExpanded = useCallback((folderId: string, expanded: boolean) => {
    writeFolderTreeExpandedState(storage, folderId, expanded);
    setExpandedFolders((current) => ({ ...current, [folderId]: expanded }));
  }, [storage]);
  const toggleProjectExpanded = useCallback((folderId: string) => {
    setProjectExpanded(folderId, !isProjectExpanded(folderId));
  }, [isProjectExpanded, setProjectExpanded]);
  useEffect(() => {
    if (!selectedFolderId) return;
    const byId = new Map(folders.map((folder) => [folder.id, folder]));
    const ancestors: string[] = [];
    let parentId = byId.get(selectedFolderId)?.parentFolderId;
    while (parentId && byId.has(parentId)) {
      ancestors.push(parentId);
      parentId = byId.get(parentId)?.parentFolderId;
    }
    if (ancestors.length === 0) return;
    for (const folderId of ancestors) writeFolderTreeExpandedState(storage, folderId, true);
    setExpandedFolders((current) => ancestors.every((folderId) => current[folderId] === true)
      ? current
      : Object.fromEntries([...Object.entries(current), ...ancestors.map((folderId) => [folderId, true])]));
  }, [folders, selectedFolderId, storage]);

  const reorderProjects = useCallback(async (items: CatalogFolderReorderItem[]) => {
    const moved = items.find((item) => {
      const current = folders.find((folder) => folder.id === item.id);
      return current && (current.parentFolderId ?? null) !== (item.parentFolderId ?? null);
    });
    if (moved?.parentFolderId) setProjectExpanded(moved.parentFolderId, true);
    setError(null);
    try {
      await onReorderProjects(items);
    } catch (cause) {
      setError(`프로젝트 이동 실패 · ${errorText(cause)}`);
    }
  }, [folders, onReorderProjects, setProjectExpanded]);

  const requestDeleteProject = useCallback((folder: CatalogFolder) => {
    if (projectHasContents(folder.id)) setDeleteTarget(folder);
    else void onDeleteProject(folder).catch((cause) => setError(`폴더 보관 실패 · ${errorText(cause)}`));
  }, [onDeleteProject, projectHasContents]);

  const clearFolderStar = async (task: StarredPlannerFolder) => {
    const page = starredFolderPage(task);
    if (pendingFolderId) return;
    setPendingFolderId(page.id);
    setError(null);
    const mutationId = publishFolderStarChange({
      page: { ...page, metadata: { ...page.metadata, starred: false } },
      starred: false,
    });
    try {
      await setFolderStarred(api, page.id, false);
    } catch (cause) {
      setError(`별표 변경 실패 · ${errorText(cause)}`);
    } finally {
      clearFolderStarChange(page.id, mutationId);
      setPendingFolderId(null);
    }
  };
  const toggleFolderStar = async (folder: CatalogFolder) => {
    if (!folder.projectPageId || isSystemFolderId(folder.id) || pendingFolderId) return;
    const starred = starredFolderIds.includes(folder.projectPageId);
    setPendingFolderId(folder.projectPageId);
    setError(null);
    try {
      const page = (await api.getPage(folder.projectPageId)).page;
      const mutationId = publishFolderStarChange({ page: { ...page,
        metadata: { ...page.metadata, starred: !starred } }, starred: !starred });
      try { await setFolderStarred(api, page.id, !starred); }
      finally { clearFolderStarChange(page.id, mutationId); }
    } catch (cause) {
      setError(`별표 변경 실패 · ${errorText(cause)}`);
    } finally {
      setPendingFolderId(null);
    }
  };
  const toggleFolderToday = async (folder: CatalogFolder) => {
    if (!folder.projectPageId || isSystemFolderId(folder.id)) return;
    try {
      await onToggleFolderToday((await api.getPage(folder.projectPageId)).page);
    } catch (cause) {
      setError(`오늘 목록 변경 실패 · ${errorText(cause)}`);
    }
  };

  return (
    <nav
      ref={surfaceRef}
      className="v3-navigation border border-glass-border glass-strong glass-chrome lg-rim"
      data-liquid-glass-webgl={webglActive ? "true" : undefined}
      aria-label="플래너 내비게이션"
    >
      <div className="v3-navigation-scroll" data-testid="v3-navigation-scroll">
      <h2>데일리</h2>
      <div className="v3-nav-list">
        {dates.map((item) => (
          <button
            type="button"
            key={item.date}
            className={selectedFolderId === null && selectedDate === item.date ? "is-active" : ""}
            onClick={() => onSelectDate(item.date)}
          >
            <span className="v3-emoji" aria-hidden="true">📅</span>
            <span>{item.label}</span>
          </button>
        ))}
      </div>

      <h2>중요 작업</h2>
      <DashboardDndProvider
        collisionDetection={pointerFirstCollisionDetection}
        onReorderStarredFolders={(movedPageId, orderedPageIds) => {
          void onReorderStarredFolders(movedPageId, orderedPageIds);
        }}
      >
        <div className="v3-nav-list" data-testid="v3-starred-tasks">
          <StarredFolderSortableContext ids={starredFolderIds}>
            {starredFolders.map((task) => {
              const page = starredFolderPage(task);
              return (
                <StarredFolderNavigationRow
                  key={page.id}
                  task={task}
                  pageIds={starredFolderIds}
                  onReorderByKeyboard={onReorderStarredFolders}
                  disabled={starredFoldersLoading || pendingFolderId === page.id}
                  onSelect={() => onSelectStarredFolder(task)}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setContextMenu({ target: { x: event.clientX, y: event.clientY }, kind: "starred_folder", task });
                  }}
                />
              );
            })}
          </StarredFolderSortableContext>
          {starredFolders.length === 0 ? <p>{starredFoldersLoading ? "업무를 불러오는 중…" : "별표 업무가 없습니다."}</p> : null}
          {starredFoldersHasMore ? (
            <DashboardIconCap
              label="별표 업무 더 보기"
              data-testid="v3-load-more-starred-tasks"
              disabled={starredFoldersLoading}
              onClick={onLoadMoreStarredFolders}
            >
              <ChevronsDown className="h-4 w-4" aria-hidden="true" />
            </DashboardIconCap>
          ) : null}
        </div>
      </DashboardDndProvider>

      <h2>전체 프로젝트</h2>
      <div className="v3-nav-list" data-testid="v3-all-projects">
        <ProjectNavigationTree
          folders={visibleFolders}
          selectedFolderId={selectedFolderId}
          isExpanded={isProjectExpanded}
          onToggleExpanded={toggleProjectExpanded}
          onSelect={onSelectFolder}
          onContextMenu={(event, folder) => {
            event.preventDefault();
            setContextMenu({ target: { x: event.clientX, y: event.clientY }, kind: "folder", folder });
          }}
          onReorder={reorderProjects}
        />
        {catalogLoadError ? <p className="v3-project-star-error" role="alert">{catalogLoadError}</p> : null}
        {!catalogLoadError && visibleFolders.length === 0 ? <p>프로젝트가 없습니다.</p> : null}
        <DashboardIconCap
          label="새 프로젝트"
          className="v3-new-project-trigger"
          aria-expanded={projectDialog?.mode === "create" && projectDialog.parentFolderId === null}
          onClick={() => { setProjectDialog({ mode: "create", parentFolderId: null, parentName: null }); setError(null); }}
        >
          <FolderPlus className="h-4 w-4" aria-hidden="true" />
        </DashboardIconCap>
        {error ? <p className="v3-project-star-error" role="alert">{error}</p> : null}
      </div>
      </div>

      <V3ContextMenu
        target={contextMenu?.target ?? null}
        onClose={() => setContextMenu(null)}
        actions={contextMenu?.kind === "starred_folder" && folders.some((folder) => folder.projectPageId === starredFolderPage(contextMenu.task).id && !folder.checklistEnabled) ? [
          { label: "폴더 열기", onSelect: () => onSelectStarredFolder(contextMenu.task) },
          { label: "폴더 페이지 ID 복사", onSelect: () => navigator.clipboard.writeText(starredFolderPage(contextMenu.task).id) },
          { label: "별표 해제", onSelect: () => clearFolderStar(contextMenu.task), separatorBefore: true },
          { label: todayFolderIds.has(starredFolderPage(contextMenu.task).id) ? "오늘에서 제외" : "오늘에 추가", onSelect: () => onToggleFolderToday(contextMenu.task) },
        ] : contextMenu?.kind === "starred_folder" ? buildFolderContextMenuActions({
          starred: folderStarredState(starredFolderPage(contextMenu.task).id, folderStarChanges, true),
          completed: completedFolderIds.has(starredFolderPage(contextMenu.task).id),
          inToday: todayFolderIds.has(starredFolderPage(contextMenu.task).id),
        }, {
          open: () => onSelectStarredFolder(contextMenu.task),
          copyId: () => navigator.clipboard.writeText(starredFolderPage(contextMenu.task).id),
          toggleStar: () => clearFolderStar(contextMenu.task),
          moveToProject: () => onMoveFolderToParent(contextMenu.task),
          complete: () => onCompleteFolder(contextMenu.task),
          toggleToday: () => onToggleFolderToday(contextMenu.task),
        }) : contextMenu?.kind === "folder" ? buildProjectContextMenuActions({
          open: () => onSelectFolder(contextMenu.folder),
          copyId: () => navigator.clipboard.writeText(contextMenu.folder.id),
          createTask: () => onCreateFolder(contextMenu.folder.id),
          createProject: () => setProjectDialog({ mode: "create", parentFolderId: null, parentName: null }),
          createChildProject: () => setProjectDialog({ mode: "create", parentFolderId: contextMenu.folder.id, parentName: contextMenu.folder.name }),
          edit: () => setProjectDialog({ mode: "edit", folder: contextMenu.folder }),
          remove: () => requestDeleteProject(contextMenu.folder),
        }).concat(contextMenu.folder.projectPageId && !isSystemFolderId(contextMenu.folder.id) ? [
          { label: starredFolderIds.includes(contextMenu.folder.projectPageId) ? "별표 해제" : "별표 추가",
            onSelect: () => toggleFolderStar(contextMenu.folder) },
          { label: todayFolderIds.has(contextMenu.folder.projectPageId) ? "오늘에서 제외" : "오늘에 추가",
            onSelect: () => toggleFolderToday(contextMenu.folder) },
        ] : []) : []}
      />
      <ProjectDialog
        target={projectDialog}
        onClose={() => setProjectDialog(null)}
        onCreateIdentity={onCreateProject}
        onRename={onRenameProject}
        onSaveContext={(pageId, previous, value) => saveProjectFormContext(api, pageId, previous, value)}
        onSaved={(folder) => {
          if (folder.parentFolderId) setProjectExpanded(folder.parentFolderId, true);
        }}
      />
      <Dialog open={deleteTarget !== null} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <DialogPopup className="max-w-sm">
          <DialogHeader>
            <DialogTitle>폴더 보관</DialogTitle>
            <DialogDescription>
              &lsquo;{deleteTarget?.name ?? ""}&rsquo; 폴더를 보관합니다. 내용과 세션은 보존됩니다.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter variant="bare">
            <Button type="button" variant="outline" onClick={() => setDeleteTarget(null)}>취소</Button>
            <Button type="button" variant="destructive" onClick={() => {
              if (!deleteTarget) return;
              const folder = deleteTarget;
              setDeleteTarget(null);
              void onDeleteProject(folder).catch((cause) => setError(`폴더 보관 실패 · ${errorText(cause)}`));
            }}>보관</Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      <div className="v3-nav-foot">
        <div><kbd>C</kbd> 새 업무 · <kbd>Esc</kbd> 닫기</div>
      </div>
    </nav>
  );
}

function StarredFolderNavigationRow({
  task,
  pageIds,
  onReorderByKeyboard,
  disabled,
  onSelect,
  onContextMenu,
}: {
  task: StarredPlannerFolder;
  pageIds: string[];
  onReorderByKeyboard(movedPageId: string, orderedPageIds: readonly string[]): Promise<void>;
  disabled: boolean;
  onSelect(): void;
  onContextMenu(event: MouseEvent<HTMLButtonElement>): void;
}) {
  const page = starredFolderPage(task);
  const drag = useStarredFolderDragSurface({ id: page.id, pageIds, disabled });
  const [keyboardAnnouncement, setKeyboardAnnouncement] = useState("");
  return (
    <div
      ref={drag.setNodeRef}
      className={`v3-starred-task-row${drag.isDragging ? " is-dragging" : ""}${drag.isOver ? " is-drop-target" : ""}`}
      style={drag.style}
      data-testid={`v3-starred-task-row-${page.id}`}
    >
      <button
        type="button"
        className="v3-starred-task-link"
        disabled={disabled}
        onClick={onSelect}
        onContextMenu={onContextMenu}
      >
        <span aria-hidden="true">★</span><span>{page.title}</span>
      </button>
      <button
        type="button"
        className="v3-starred-task-drag-handle"
        ref={drag.setActivatorNodeRef}
        aria-label={`중요 작업 ${page.title} 순서 변경`}
        aria-keyshortcuts="ArrowUp ArrowDown"
        title="위·아래 화살표 키로 순서를 바꿉니다"
        disabled={disabled}
        onKeyDownCapture={(event) => {
          if (event.altKey || event.ctrlKey || event.metaKey) return;
          const offset = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
          if (!offset) return;
          const currentIndex = pageIds.indexOf(page.id);
          const targetPageId = pageIds[currentIndex + offset];
          if (currentIndex < 0 || !targetPageId) return;
          event.preventDefault();
          event.stopPropagation();
          const orderedPageIds = reorderStarredFolderIds(pageIds, page.id, targetPageId);
          if (!orderedPageIds) return;
          setKeyboardAnnouncement(`${page.title}, ${orderedPageIds.indexOf(page.id) + 1}번째로 이동합니다.`);
          void onReorderByKeyboard(page.id, orderedPageIds);
        }}
        {...drag.attributes}
        {...drag.listeners}
        onContextMenu={onContextMenu}
      >
        <GripVertical className="h-4 w-4" aria-hidden="true" />
      </button>
      <span className="sr-only" aria-live="polite" aria-atomic="true">{keyboardAnnouncement}</span>
    </div>
  );
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}
