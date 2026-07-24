import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  BOARD_CANVAS_HEIGHT,
  BOARD_CANVAS_ORIGIN_X,
  BOARD_CANVAS_ORIGIN_Y,
  BOARD_CANVAS_WIDTH,
  type BoardWorkspaceItem,
} from "./board-workspace-items";
import type { BoardItemPositionUpdate, BoardPoint } from "./board-selection";
import {
  centerBoardPointInScroller,
  clampBoardZoom,
  DEFAULT_BOARD_ZOOM,
  getBoardGridStyle,
  getCanvasBoardPoint,
  getScaledCanvasSize,
  getViewportBoardRect,
  readBoardViewport,
  setScrollerZoomAroundClientPoint,
  type BoardViewport,
} from "./board-viewport";
import { useBoardWorkspaceDrag } from "./useBoardWorkspaceDrag";
import { useDashboardStore } from "../stores/dashboard-store";

interface UseBoardCanvasViewportOptions {
  selectedFolderId: string | null;
  boardItems: BoardWorkspaceItem[];
  selectedBoardItemIds: Set<string>;
  selectBoardItems: (boardItemIds: string[], primaryBoardItemId: string | null) => void;
  toggleBoardItemSelection: (boardItemId: string) => void;
  clearBoardSelection: () => void;
  raiseBoardItems: (boardItemIds: string[]) => void;
  updateBoardItemPositions: (updates: BoardItemPositionUpdate[]) => void;
  /**
   * 지정 시 보드 zoom/pan을 task 레이아웃(dashboard-store persist)에 저장·복원한다(🔴23②).
   * 미지정(폴더 보드 등)이면 기존 동작(매 진입 origin 리셋)을 그대로 유지한다.
   */
  viewportPersistenceKey?: string | null;
}

export function useBoardCanvasViewport({
  selectedFolderId,
  boardItems,
  selectedBoardItemIds,
  selectBoardItems,
  toggleBoardItemSelection,
  clearBoardSelection,
  raiseBoardItems,
  updateBoardItemPositions,
  viewportPersistenceKey = null,
}: UseBoardCanvasViewportOptions) {
  // 최초 마운트 시 1회만 저장된 viewport를 읽는다(이후 store 변경엔 재구독하지 않음).
  const initialViewportRef = useRef<{ zoom?: number; scrollLeft?: number; scrollTop?: number } | null>(
    viewportPersistenceKey
      ? (() => {
          const snap = useDashboardStore.getState().taskBoardLayouts[viewportPersistenceKey];
          return snap
            ? { zoom: snap.boardZoom, scrollLeft: snap.boardScrollLeft, scrollTop: snap.boardScrollTop }
            : null;
        })()
      : null,
  );
  const initialZoom = clampBoardZoom(initialViewportRef.current?.zoom ?? DEFAULT_BOARD_ZOOM);
  const [zoom, setZoom] = useState(initialZoom);
  const [minimapCollapsed, setMinimapCollapsed] = useState(false);
  const [viewport, setViewport] = useState<BoardViewport>({ scrollLeft: 0, scrollTop: 0, width: 0, height: 0 });
  const scrollRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef(initialZoom);
  const restoredKeyRef = useRef<string | null>(null);

  const resolveBoardPoint = useCallback((clientX: number, clientY: number) => {
    const canvas = scrollRef.current?.querySelector<HTMLElement>('[data-testid="board-workspace-canvas"]');
    if (!canvas) return { x: 0, y: 0 };
    return getCanvasBoardPoint(clientX, clientY, canvas, zoomRef.current);
  }, []);

  const refreshViewport = useCallback(() => {
    const scroller = scrollRef.current;
    if (scroller) setViewport(readBoardViewport(scroller));
  }, []);

  const handleCanvasWheel = useCallback((event: WheelEvent) => {
    if (!event.ctrlKey && !event.metaKey) return;
    const scroller = scrollRef.current;
    const canvas = scroller?.querySelector<HTMLElement>('[data-testid="board-workspace-canvas"]');
    if (!scroller || !canvas) return;
    event.preventDefault();
    const currentZoom = zoomRef.current;
    const nextZoom = clampBoardZoom(currentZoom * (event.deltaY > 0 ? 0.9 : 1.1));
    if (nextZoom === currentZoom) return;
    setScrollerZoomAroundClientPoint(scroller, canvas, currentZoom, nextZoom, event.clientX, event.clientY);
    zoomRef.current = nextZoom;
    setZoom(nextZoom);
    refreshViewport();
  }, [refreshViewport]);

  const handleMinimapMoveViewport = useCallback((point: BoardPoint) => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    centerBoardPointInScroller(scroller, point, zoomRef.current);
    refreshViewport();
  }, [refreshViewport]);

  const setZoomAroundViewportCenter = useCallback((value: number) => {
    const nextZoom = clampBoardZoom(value);
    const currentZoom = zoomRef.current;
    if (nextZoom === currentZoom) return;

    const scroller = scrollRef.current;
    if (!scroller) {
      zoomRef.current = nextZoom;
      setZoom(nextZoom);
      return;
    }

    const currentViewport = readBoardViewport(scroller);
    const viewportRect = getViewportBoardRect(currentViewport, currentZoom);
    const viewportCenter = {
      x: viewportRect.x + viewportRect.width / 2,
      y: viewportRect.y + viewportRect.height / 2,
    };
    zoomRef.current = nextZoom;
    setZoom(nextZoom);
    centerBoardPointInScroller(scroller, viewportCenter, nextZoom);
    refreshViewport();
  }, [refreshViewport]);

  const handleZoomIn = useCallback(() => {
    setZoomAroundViewportCenter(zoomRef.current + 0.1);
  }, [setZoomAroundViewportCenter]);

  const handleZoomOut = useCallback(() => {
    setZoomAroundViewportCenter(zoomRef.current - 0.1);
  }, [setZoomAroundViewportCenter]);

  const dragControls = useBoardWorkspaceDrag({
    scrollRef,
    zoom,
    boardItems,
    selectedBoardItemIds,
    resolveBoardPoint,
    selectBoardItems,
    toggleBoardItemSelection,
    clearBoardSelection,
    raiseBoardItems,
    updateBoardItemPositions,
  });

  const dragPreviewByItemId = useMemo(() => {
    return new Map(dragControls.dragPreviews.map((preview) => [preview.boardItemId, preview]));
  }, [dragControls.dragPreviews]);

  const planeStyle = useMemo(() => getScaledCanvasSize(zoom), [zoom]);
  const canvasStyle = useMemo(() => ({
    width: BOARD_CANVAS_WIDTH,
    height: BOARD_CANVAS_HEIGHT,
    transform: `scale(${zoom})`,
    transformOrigin: "0 0",
    willChange: "transform",
    ...getBoardGridStyle(zoom),
  }), [zoom]);

  useEffect(() => {
    zoomRef.current = zoom;
    refreshViewport();
  }, [refreshViewport, zoom]);

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    // 🔴23②: 영속 키가 있으면 최초 1회 저장된 pan으로 복원하고, 같은 키에서 이후
    // selectedFolderId 변화엔 origin 리셋을 건너뛰어 복원 위치를 보존한다.
    if (viewportPersistenceKey) {
      if (restoredKeyRef.current === viewportPersistenceKey) return;
      restoredKeyRef.current = viewportPersistenceKey;
      const initial = initialViewportRef.current;
      if (initial && (initial.scrollLeft != null || initial.scrollTop != null)) {
        scroller.scrollLeft = initial.scrollLeft ?? (BOARD_CANVAS_ORIGIN_X - 80) * zoomRef.current;
        scroller.scrollTop = initial.scrollTop ?? (BOARD_CANVAS_ORIGIN_Y - 60) * zoomRef.current;
        clearBoardSelection();
        refreshViewport();
        return;
      }
    }
    scroller.scrollLeft = (BOARD_CANVAS_ORIGIN_X - 80) * zoomRef.current;
    scroller.scrollTop = (BOARD_CANVAS_ORIGIN_Y - 60) * zoomRef.current;
    clearBoardSelection();
    refreshViewport();
  }, [clearBoardSelection, refreshViewport, selectedFolderId, viewportPersistenceKey]);

  // 🔴23②: viewport(zoom/pan) 변경을 task 레이아웃에 디바운스 저장한다.
  useEffect(() => {
    if (!viewportPersistenceKey) return undefined;
    const scroller = scrollRef.current;
    if (!scroller) return undefined;
    let timer = 0;
    const persist = () => {
      timer = 0;
      useDashboardStore.getState().setTaskBoardLayout(viewportPersistenceKey, {
        boardZoom: zoomRef.current,
        boardScrollLeft: Math.round(scroller.scrollLeft),
        boardScrollTop: Math.round(scroller.scrollTop),
      });
    };
    const schedule = () => {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(persist, 400);
    };
    scroller.addEventListener("scroll", schedule, { passive: true });
    schedule();
    return () => {
      scroller.removeEventListener("scroll", schedule);
      if (timer) window.clearTimeout(timer);
    };
  }, [viewportPersistenceKey, zoom]);

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    refreshViewport();
    const handleScroll = () => refreshViewport();
    scroller.addEventListener("scroll", handleScroll, { passive: true });
    scroller.addEventListener("wheel", handleCanvasWheel, { passive: false });
    window.addEventListener("resize", handleScroll);
    return () => {
      scroller.removeEventListener("scroll", handleScroll);
      scroller.removeEventListener("wheel", handleCanvasWheel);
      window.removeEventListener("resize", handleScroll);
    };
  }, [handleCanvasWheel, refreshViewport]);

  return {
    scrollRef,
    zoom,
    viewport,
    minimapCollapsed,
    setMinimapCollapsed,
    resolveBoardPoint,
    handleMinimapMoveViewport,
    handleZoomIn,
    handleZoomOut,
    dragPreviewByItemId,
    planeStyle,
    canvasStyle,
    ...dragControls,
  };
}
