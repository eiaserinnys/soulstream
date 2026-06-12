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

interface UseBoardCanvasViewportOptions {
  selectedFolderId: string | null;
  boardItems: BoardWorkspaceItem[];
  selectedBoardItemIds: Set<string>;
  selectBoardItems: (boardItemIds: string[], primaryBoardItemId: string | null) => void;
  toggleBoardItemSelection: (boardItemId: string) => void;
  clearBoardSelection: () => void;
  raiseBoardItems: (boardItemIds: string[]) => void;
  updateBoardItemPositions: (updates: BoardItemPositionUpdate[]) => void;
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
}: UseBoardCanvasViewportOptions) {
  const [zoom, setZoom] = useState(DEFAULT_BOARD_ZOOM);
  const [minimapCollapsed, setMinimapCollapsed] = useState(false);
  const [viewport, setViewport] = useState<BoardViewport>({ scrollLeft: 0, scrollTop: 0, width: 0, height: 0 });
  const scrollRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef(DEFAULT_BOARD_ZOOM);

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
    scroller.scrollLeft = (BOARD_CANVAS_ORIGIN_X - 80) * zoomRef.current;
    scroller.scrollTop = (BOARD_CANVAS_ORIGIN_Y - 60) * zoomRef.current;
    clearBoardSelection();
    refreshViewport();
  }, [clearBoardSelection, refreshViewport, selectedFolderId]);

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
