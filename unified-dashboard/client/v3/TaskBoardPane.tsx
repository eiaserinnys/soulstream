import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Button,
  retainEqualValue,
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
import { V3ErrorNotice } from "./V3ErrorNotice";
import { useV3InvalidationKey } from "./v3-live-invalidation-plane";
import { loadConfirmedResult } from "./planner-query-state";
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
  const boardItemsRef = useRef(boardItems);
  const loadedRunbookIdRef = useRef<string | null>(null);
  boardItemsRef.current = boardItems;
  const sessionIds = useMemo(
    () => extractTaskBoardSessionIds(boardItems ?? []),
    [boardItems],
  );
  const invalidationKey = useV3InvalidationKey([
    "catalog", "runbook", "replay",
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

  const reloadBoardItems = useCallback(async () => {
    try {
      const next = await loadConfirmedResult({
        previous: boardItemsRef.current,
        load: () => fetchTaskBoardContainerItems(runbookId),
        clearsVisibleContent: (current, result) => current.length > 0 && result.length === 0,
      });
      loadedRunbookIdRef.current = runbookId;
      setBoardItems((current) => retainEqualValue(current ?? undefined, next));
      setLoadError(null);
    } catch (error) {
      console.error("[v3/task-board] 보드 항목 재조회 실패", error);
      setLoadError(errorText(error));
    }
  }, [runbookId]);

  useEffect(() => {
    const controller = new AbortController();
    const sameRunbook = loadedRunbookIdRef.current === runbookId;
    if (!sameRunbook) setBoardItems(null);
    const load = () => fetchTaskBoardContainerItems(runbookId, (input, init) => globalThis.fetch(input, {
        ...init,
        signal: controller.signal,
      }));
    void loadConfirmedResult({
      previous: sameRunbook ? boardItemsRef.current : null,
      load,
      clearsVisibleContent: (current, result) => current.length > 0 && result.length === 0,
    }).then((next) => {
      loadedRunbookIdRef.current = runbookId;
      setBoardItems((current) => retainEqualValue(current ?? undefined, next));
      setLoadError(null);
    }).catch((error: unknown) => {
      if (error instanceof DOMException && error.name === "AbortError") return;
      console.error("[v3/task-board] 보드 항목 조회 실패", error);
      setLoadError(errorText(error));
    });
    return () => controller.abort();
  }, [invalidationKey, runbookId]);

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
          <V3ErrorNotice className="v3-board-load-state" message="업무 보드를 열지 못했습니다." detail={loadError}>
            <Button variant="secondary" onClick={() => { void reloadBoardItems(); }}>다시 시도</Button>
          </V3ErrorNotice>
        ) : boardItems === null ? (
          <div className="v3-board-load-state" data-testid="v3-task-board-loading">런북 내용을 불러오는 중…</div>
        ) : (
          <BoardWorkspaceView sessions={displaySessions} />
        )}
      </div>
    </article>
  );
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}
