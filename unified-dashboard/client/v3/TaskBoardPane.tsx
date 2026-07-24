import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Button,
  DashboardIconCap,
  retainEqualValue,
  useDashboardStore,
  useSessionListProvider,
  type CatalogBoardItem,
  type SessionSummary,
} from "@seosoyoung/soul-ui";
import { ArrowLeft, X } from "lucide-react";

import { BoardWorkspaceView } from "../components/BoardWorkspaceView";
import { orchestratorSessionProvider } from "../providers";
import { fetchTaskBoardContainerItems } from "./task-inline-board-api";
import {
  buildTaskBoardCatalog,
  extractTaskBoardSessionIds,
  mergeTaskBoardSessions,
} from "./task-board-model";
import { V3ErrorNotice } from "./V3ErrorNotice";
import { useV3InvalidationKey } from "./v3-live-invalidation-plane";
import { loadConfirmedResult } from "./planner-query-state";
import type { PlannerTask } from "./planner-data";
import "./v3-task-board.css";

export function TaskBoardPane({
  taskId,
  projectFolderId,
  projectTitle,
  sessions,
  taskMoveTargets,
  viewportPersistenceKey,
  onBoardItemsChanged,
  onOpenMarkdownDocument,
  onOpenCustomView,
  onClose,
}: {
  taskId: string;
  projectFolderId: string | null;
  projectTitle: string;
  sessions: readonly SessionSummary[];
  taskMoveTargets: readonly PlannerTask[];
  viewportPersistenceKey?: string;
  onBoardItemsChanged(items: readonly CatalogBoardItem[]): void;
  onOpenMarkdownDocument(documentId: string): void;
  onOpenCustomView(customViewId: string): void;
  onClose(): void;
}) {
  const [boardItems, setBoardItems] = useState<CatalogBoardItem[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const previousStoreRef = useRef<Partial<ReturnType<typeof useDashboardStore.getState>> | null>(null);
  const catalogInitializedRef = useRef(false);
  const boardItemsRef = useRef(boardItems);
  const loadedTaskIdRef = useRef<string | null>(null);
  boardItemsRef.current = boardItems;
  const sessionIds = useMemo(
    () => extractTaskBoardSessionIds(boardItems ?? []),
    [boardItems],
  );
  const invalidationKey = useV3InvalidationKey([
    "catalog", "task", "replay",
  ]);
  const {
    sessions: boardSessions,
    loading: boardSessionsLoading,
  } = useSessionListProvider({
    enabled: boardItems !== null && sessionIds.length > 0,
    getSessionProvider: () => orchestratorSessionProvider,
    sessionIds,
    streamEnabled: false,
    initialCatalogLoadEnabled: false,
    folderCountsEnabled: false,
  });
  const displaySessions = useMemo(
    () => mergeTaskBoardSessions(sessions, boardSessions),
    [boardSessions, sessions],
  );

  const removeSourceBoardItem = useCallback((boardItemId: string, movedItem?: CatalogBoardItem) => {
    setBoardItems((current) => current?.filter((item) => item.id !== boardItemId) ?? current);
    const previous = previousStoreRef.current;
    if (!previous?.catalog) return;
    previousStoreRef.current = {
      ...previous,
      catalog: {
        ...previous.catalog,
        boardItems: [
          ...(previous.catalog.boardItems ?? []).filter((item) => item.id !== boardItemId),
          ...(movedItem ? [movedItem] : []),
        ],
      },
    };
  }, []);

  const reloadBoardItems = useCallback(async () => {
    try {
      const next = await loadConfirmedResult({
        previous: boardItemsRef.current,
        load: () => fetchTaskBoardContainerItems(taskId),
        clearsVisibleContent: (current, result) => current.length > 0 && result.length === 0,
      });
      loadedTaskIdRef.current = taskId;
      setBoardItems((current) => retainEqualValue(current ?? undefined, next));
      setLoadError(null);
    } catch (error) {
      console.error("[v3/task-board] 보드 항목 재조회 실패", error);
      setLoadError(errorText(error));
    }
  }, [taskId]);

  useEffect(() => {
    const controller = new AbortController();
    const sameTask = loadedTaskIdRef.current === taskId;
    if (!sameTask) setBoardItems(null);
    const load = () => fetchTaskBoardContainerItems(
      taskId,
      globalThis.fetch.bind(globalThis),
      controller.signal,
    );
    void loadConfirmedResult({
      previous: sameTask ? boardItemsRef.current : null,
      load,
      clearsVisibleContent: (current, result) => current.length > 0 && result.length === 0,
    }).then((next) => {
      loadedTaskIdRef.current = taskId;
      setBoardItems((current) => retainEqualValue(current ?? undefined, next));
      setLoadError(null);
    }).catch((error: unknown) => {
      if (error instanceof DOMException && error.name === "AbortError") return;
      console.error("[v3/task-board] 보드 항목 조회 실패", error);
      setLoadError(errorText(error));
    });
    return () => controller.abort();
  }, [invalidationKey, taskId]);

  useEffect(() => {
    onBoardItemsChanged(boardItems ?? []);
  }, [boardItems, onBoardItemsChanged]);

  useEffect(() => {
    const state = useDashboardStore.getState();
    previousStoreRef.current = {
      catalog: state.catalog,
      catalogVersion: state.catalogVersion,
      activeBoardContainer: state.activeBoardContainer,
      selectedFolderId: state.selectedFolderId,
      focusedBoardItem: state.focusedBoardItem,
      viewMode: state.viewMode,
      leftNavigationMode: state.leftNavigationMode,
      activeTab: state.activeTab,
      activeBoardDocumentId: state.activeBoardDocumentId,
      activeCustomViewId: state.activeCustomViewId,
    };
    return () => {
      if (previousStoreRef.current) useDashboardStore.setState(previousStoreRef.current);
    };
  }, []);

  useEffect(() => {
    if (boardItems === null) return;
    const state = useDashboardStore.getState();
    const currentCatalog = catalogInitializedRef.current ? state.catalog : null;
    const nextCatalog = retainEqualValue(currentCatalog ?? undefined, buildTaskBoardCatalog({
      currentCatalog,
      boardItems,
      sessions: displaySessions,
      projectFolderId,
      projectTitle,
    }));
    if (nextCatalog !== currentCatalog) state.setCatalog(nextCatalog);
    if (!catalogInitializedRef.current) {
      state.openTaskBoard(taskId, projectFolderId);
      catalogInitializedRef.current = true;
    }
  }, [boardItems, displaySessions, projectFolderId, projectTitle, taskId]);

  return (
    <article
      className="v3-detail-pane v3-board-pane border border-glass-border glass-strong glass-chrome lg-rim"
      data-testid="v3-task-board-pane"
      data-board-item-count={boardItems?.length ?? 0}
      data-board-session-count={sessionIds.length}
    >
      <header className="v3-workspace-toolbar">
        <DashboardIconCap label="업무 상세로 돌아가기" onClick={onClose}>
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        </DashboardIconCap>
        <strong>▦ 업무 보드</strong>
        <span className="v3-board-live-state">
          {boardItems === null || boardSessionsLoading ? "불러오는 중" : `${boardItems.length}개 항목 · 실시간`}
        </span>
        <span className="v3-spacer" />
        <DashboardIconCap label="업무 보드 닫기" onClick={onClose}>
          <X className="h-4 w-4" aria-hidden="true" />
        </DashboardIconCap>
      </header>
      <div className="v3-full-board">
        {loadError ? (
          <V3ErrorNotice className="v3-board-load-state" message="업무 보드를 열지 못했습니다." detail={loadError}>
            <Button variant="secondary" onClick={() => { void reloadBoardItems(); }}>다시 시도</Button>
          </V3ErrorNotice>
        ) : boardItems === null ? (
          <div className="v3-board-load-state" data-testid="v3-task-board-loading">업무 내용을 불러오는 중…</div>
        ) : (
          <BoardWorkspaceView
            sessions={displaySessions}
            viewportPersistenceKey={viewportPersistenceKey}
            taskMoveTargets={taskMoveTargets
              .filter((target) => target.taskId !== taskId)
              .map((target) => ({ id: target.taskId, title: target.page.title }))}
            onBoardItemMoved={(item) => removeSourceBoardItem(item.id, item)}
            onMarkdownDocumentDeleted={(_documentId, boardItemId) => removeSourceBoardItem(boardItemId)}
            onOpenMarkdownDocument={onOpenMarkdownDocument}
            onOpenCustomView={onOpenCustomView}
          />
        )}
      </div>
    </article>
  );
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}
