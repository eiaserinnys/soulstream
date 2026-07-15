import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  useDashboardStore,
  useSessionListProvider,
  type CatalogBoardItem,
  type SessionSummary,
} from "@seosoyoung/soul-ui";

import { BoardWorkspaceView } from "../components/BoardWorkspaceView";
import { orchestratorSessionProvider } from "../providers";
import { fetchTaskBoardContainerItems } from "./task-inline-board-api";
import {
  buildTaskBoardCatalog,
  extractTaskBoardSessionIds,
  mergeTaskBoardSessions,
} from "./task-board-model";
import { useV3InvalidationKey } from "./v3-live-invalidation-plane";
import "./v3-task-board.css";

export function TaskBoardPane({
  runbookId,
  projectFolderId,
  projectTitle,
  sessions,
  onClose,
}: {
  runbookId: string;
  projectFolderId: string | null;
  projectTitle: string;
  sessions: readonly SessionSummary[];
  onClose(): void;
}) {
  const [boardItems, setBoardItems] = useState<CatalogBoardItem[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const previousStoreRef = useRef<Partial<ReturnType<typeof useDashboardStore.getState>> | null>(null);
  const catalogInitializedRef = useRef(false);
  const sessionIds = useMemo(
    () => extractTaskBoardSessionIds(boardItems ?? []),
    [boardItems],
  );
  const invalidationKey = useV3InvalidationKey([
    "session", "catalog", "runbook", "custom_view", "page", "replay", "local",
  ]);
  const {
    sessions: boardSessions,
    loading: boardSessionsLoading,
    refetch: refetchBoardSessions,
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

  const reloadBoardItems = useCallback(async () => {
    try {
      const next = await fetchTaskBoardContainerItems(runbookId);
      setBoardItems(next);
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "보드 항목을 불러오지 못했습니다");
    }
  }, [runbookId]);

  useEffect(() => {
    const controller = new AbortController();
    void fetchTaskBoardContainerItems(runbookId, (input, init) => globalThis.fetch(input, {
      ...init,
      signal: controller.signal,
    })).then((next) => {
      setBoardItems(next);
      setLoadError(null);
    }).catch((error: unknown) => {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setLoadError(error instanceof Error ? error.message : "보드 항목을 불러오지 못했습니다");
    });
    if (invalidationKey > 0) void refetchBoardSessions();
    return () => controller.abort();
  }, [invalidationKey, refetchBoardSessions, runbookId]);

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
      activeSessionKey: state.activeSessionKey,
      activeSession: state.activeSession,
      activeSessionSummary: state.activeSessionSummary,
      activeBoardDocumentId: state.activeBoardDocumentId,
      activeCustomViewId: state.activeCustomViewId,
      activeRightTab: state.activeRightTab,
      selectedSessionIds: state.selectedSessionIds,
      lastSelectedSessionId: state.lastSelectedSessionId,
    };
    useDashboardStore.setState({
      activeSessionKey: null,
      activeSession: null,
      activeSessionSummary: null,
      activeBoardDocumentId: null,
      activeCustomViewId: null,
      selectedSessionIds: new Set<string>(),
      lastSelectedSessionId: null,
    });
    return () => {
      if (previousStoreRef.current) useDashboardStore.setState(previousStoreRef.current);
    };
  }, []);

  useEffect(() => {
    if (boardItems === null) return;
    const state = useDashboardStore.getState();
    const currentCatalog = catalogInitializedRef.current ? state.catalog : null;
    state.setCatalog(buildTaskBoardCatalog({
      currentCatalog,
      boardItems,
      sessions: displaySessions,
      projectFolderId,
      projectTitle,
    }));
    if (!catalogInitializedRef.current) {
      state.openRunbookBoard(runbookId, projectFolderId);
      catalogInitializedRef.current = true;
    }
  }, [boardItems, displaySessions, projectFolderId, projectTitle, runbookId]);

  return (
    <article
      className="v3-detail-pane v3-board-pane border border-glass-border glass-strong glass-chrome lg-rim"
      data-testid="v3-task-board-pane"
      data-board-item-count={boardItems?.length ?? 0}
      data-board-session-count={sessionIds.length}
    >
      <header className="v3-workspace-toolbar">
        <button type="button" className="v3-workspace-back" onClick={onClose}>← 업무</button>
        <strong>▦ 런북 보드</strong>
        <span className="v3-board-live-state">
          {boardItems === null || boardSessionsLoading ? "불러오는 중" : `${boardItems.length}개 항목 · 실시간`}
        </span>
        <span className="v3-spacer" />
        <button type="button" className="v3-workspace-close" aria-label="업무 보드 닫기" onClick={onClose}>×</button>
      </header>
      <div className="v3-full-board">
        {loadError ? (
          <div className="v3-board-load-state" role="alert">
            <strong>업무 보드를 열지 못했습니다.</strong>
            <p>{loadError}</p>
            <button type="button" className="v3-button v3-button--soft" onClick={() => { void reloadBoardItems(); }}>다시 시도</button>
          </div>
        ) : boardItems === null ? (
          <div className="v3-board-load-state" data-testid="v3-task-board-loading">런북 내용을 불러오는 중…</div>
        ) : (
          <BoardWorkspaceView sessions={displaySessions} />
        )}
      </div>
    </article>
  );
}
