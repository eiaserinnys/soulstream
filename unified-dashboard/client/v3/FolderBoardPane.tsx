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
  useSessionListProvider,
  type CatalogBoardItem,
  type SessionSummary,
} from "@seosoyoung/soul-ui";
import { ArrowLeft, X } from "lucide-react";

import { BoardWorkspaceView } from "../components/BoardWorkspaceView";
import { orchestratorSessionProvider } from "../providers";
import { fetchFolderBoardContainerItems } from "./folder-inline-board-api";
import {
  buildFolderBoardCatalog,
  extractFolderBoardSessionIds,
  mergeFolderBoardSessions,
} from "./folder-board-model";
import { V3ErrorNotice } from "./V3ErrorNotice";
import { useV3InvalidationKey, useV3PageInvalidationKey } from "./v3-live-invalidation-plane";
import { loadConfirmedResult } from "./planner-query-state";
import type { PlannerFolder } from "./planner-data";
import "./v3-folder-board.css";

export function FolderBoardPane({
  folderId,
  folderName,
  sessions,
  folderMoveTargets,
  viewportPersistenceKey,
  onBoardItemsChanged,
  onMarkdownDocumentDeleted,
  onOpenMarkdownDocument,
  onRequestMarkdownEdit,
  onOpenCustomView,
  onClose,
}: {
  folderId: string;
  folderName: string;
  sessions: readonly SessionSummary[];
  folderMoveTargets: readonly PlannerFolder[];
  viewportPersistenceKey?: string;
  onBoardItemsChanged(items: readonly CatalogBoardItem[]): void;
  onMarkdownDocumentDeleted(documentId: string, boardItemId: string): void;
  onOpenMarkdownDocument(documentId: string): void;
  onRequestMarkdownEdit(documentId: string): void;
  onOpenCustomView(customViewId: string): void;
  onClose(): void;
}) {
  const [boardItems, setBoardItems] = useState<CatalogBoardItem[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const boardItemsRef = useRef(boardItems);
  const loadedFolderIdRef = useRef<string | null>(null);
  boardItemsRef.current = boardItems;
  const sessionIds = useMemo(
    () => extractFolderBoardSessionIds(boardItems ?? []),
    [boardItems],
  );
  const invalidationKey = useV3InvalidationKey([
    "catalog", "folder", "replay",
  ]);
  const pageInvalidationKey = useV3PageInvalidationKey(
    (boardItems ?? [])
      .filter((item) => item.itemType === "markdown")
      .map((item) => item.itemId),
  );
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
    () => mergeFolderBoardSessions(sessions, boardSessions),
    [boardSessions, sessions],
  );
  const scopedCatalog = useMemo(() => buildFolderBoardCatalog({
    currentCatalog: null,
    boardItems: boardItems ?? [],
    sessions: displaySessions,
    folderId: folderId,
    folderName,
  }), [boardItems, displaySessions, folderId, folderName]);

  const removeSourceBoardItem = useCallback((boardItemId: string, movedItem?: CatalogBoardItem) => {
    setBoardItems((current) => current === null ? current : [
      ...current.filter((item) => item.id !== boardItemId),
      ...(movedItem ? [movedItem] : []),
    ]);
  }, []);

  const reloadBoardItems = useCallback(async () => {
    try {
      const next = await loadConfirmedResult({
        previous: boardItemsRef.current,
        load: () => fetchFolderBoardContainerItems(folderId),
        clearsVisibleContent: (current, result) => current.length > 0 && result.length === 0,
      });
      loadedFolderIdRef.current = folderId;
      setBoardItems((current) => retainEqualValue(current ?? undefined, next));
      setLoadError(null);
    } catch (error) {
      console.error("[v3/task-board] 보드 항목 재조회 실패", error);
      setLoadError(errorText(error));
    }
  }, [folderId]);

  useEffect(() => {
    const controller = new AbortController();
    const sameFolder = loadedFolderIdRef.current === folderId;
    if (!sameFolder) setBoardItems(null);
    const load = () => fetchFolderBoardContainerItems(
      folderId,
      globalThis.fetch.bind(globalThis),
      controller.signal,
    );
    void loadConfirmedResult({
      previous: sameFolder ? boardItemsRef.current : null,
      load,
      clearsVisibleContent: (current, result) => current.length > 0 && result.length === 0,
    }).then((next) => {
      loadedFolderIdRef.current = folderId;
      setBoardItems((current) => retainEqualValue(current ?? undefined, next));
      setLoadError(null);
    }).catch((error: unknown) => {
      if (error instanceof DOMException && error.name === "AbortError") return;
      console.error("[v3/task-board] 보드 항목 조회 실패", error);
      setLoadError(errorText(error));
    });
    return () => controller.abort();
  }, [invalidationKey, pageInvalidationKey, folderId]);

  useEffect(() => {
    onBoardItemsChanged(boardItems ?? []);
  }, [boardItems, onBoardItemsChanged]);

  return (
    <article
      className="v3-detail-pane v3-board-pane border border-glass-border glass-strong glass-chrome lg-rim"
      data-testid="v3-folder-board-pane"
      data-board-item-count={boardItems?.length ?? 0}
      data-board-session-count={sessionIds.length}
    >
      <header className="v3-workspace-toolbar">
        <DashboardIconCap label="폴더 상세로 돌아가기" onClick={onClose}>
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        </DashboardIconCap>
        <strong>▦ 폴더 보드</strong>
        <span className="v3-board-live-state">
          {boardItems === null || boardSessionsLoading ? "불러오는 중" : `${boardItems.length}개 항목 · 실시간`}
        </span>
        <span className="v3-spacer" />
        <DashboardIconCap label="폴더 보드 닫기" onClick={onClose}>
          <X className="h-4 w-4" aria-hidden="true" />
        </DashboardIconCap>
      </header>
      <div className="v3-full-board">
        {loadError ? (
          <V3ErrorNotice className="v3-board-load-state" message="폴더 보드를 열지 못했습니다." detail={loadError}>
            <Button variant="secondary" onClick={() => { void reloadBoardItems(); }}>다시 시도</Button>
          </V3ErrorNotice>
        ) : boardItems === null ? (
          <div className="v3-board-load-state" data-testid="v3-folder-board-loading">폴더 내용을 불러오는 중…</div>
        ) : (
          <BoardWorkspaceView
            catalogOverride={scopedCatalog}
            boardContainerOverride={{ kind: "folder", id: folderId }}
            selectedFolderIdOverride={folderId}
            sessions={displaySessions}
            viewportPersistenceKey={viewportPersistenceKey}
            folderMoveTargets={folderMoveTargets
              .filter((target) => target.folderId !== folderId)
              .map((target) => ({ id: target.folderId, title: target.page.title }))}
            onBoardItemMoved={(item) => removeSourceBoardItem(item.id, item)}
            onMarkdownDocumentDeleted={(documentId, boardItemId) => {
              removeSourceBoardItem(boardItemId);
              onMarkdownDocumentDeleted(documentId, boardItemId);
            }}
            onOpenMarkdownDocument={onOpenMarkdownDocument}
            onRequestMarkdownEdit={onRequestMarkdownEdit}
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
