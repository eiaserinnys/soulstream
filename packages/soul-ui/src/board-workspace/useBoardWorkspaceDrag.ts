import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, RefObject } from "react";

import type { BoardWorkspaceItem } from "./board-workspace-items";
import {
  findBoardItemsInRect,
  getDraggedBoardItems,
  isBoardSelectionToggle,
  normalizeBoardRect,
  snapBoardItemPositionUpdates,
  type BoardItemPositionUpdate,
  type BoardPoint,
  type BoardRect,
} from "./board-selection";

const DRAG_ACTIVATION_DISTANCE = 8;
const MARQUEE_ACTIVATION_DISTANCE = 4;
const AUTO_PAN_EDGE_SIZE = 48;
const AUTO_PAN_STEP = 24;

interface DragState {
  items: BoardWorkspaceItem[];
  startClientX: number;
  startClientY: number;
  startScrollLeft: number;
  startScrollTop: number;
  active: boolean;
}

interface PanState {
  startClientX: number;
  startClientY: number;
  scrollLeft: number;
  scrollTop: number;
}

interface MarqueeState {
  start: BoardPoint;
  current: BoardPoint;
  active: boolean;
}

interface UseBoardWorkspaceDragOptions {
  scrollRef: RefObject<HTMLDivElement | null>;
  zoom: number;
  boardItems: BoardWorkspaceItem[];
  selectedBoardItemIds: Set<string>;
  resolveBoardPoint: (clientX: number, clientY: number) => BoardPoint;
  selectBoardItems: (boardItemIds: string[], primaryBoardItemId: string | null) => void;
  toggleBoardItemSelection: (boardItemId: string) => void;
  clearBoardSelection: () => void;
  raiseBoardItems: (boardItemIds: string[]) => void;
  updateBoardItemPositions: (updates: BoardItemPositionUpdate[]) => void;
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
}

function isBoardTileTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && Boolean(target.closest("[data-board-tile='true']"));
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(target.closest("button, a, input, textarea, select, [contenteditable='true'], [role='menu'], [role='menuitem']"));
}

export function useBoardWorkspaceDrag({
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
}: UseBoardWorkspaceDragOptions) {
  const [isSpaceDown, setIsSpaceDown] = useState(false);
  const [isPanning, setIsPanning] = useState(false);
  const [dragPreviews, setDragPreviews] = useState<BoardItemPositionUpdate[]>([]);
  const [marqueeRect, setMarqueeRect] = useState<BoardRect | null>(null);
  const dragStateRef = useRef<DragState | null>(null);
  const dragPreviewsRef = useRef<BoardItemPositionUpdate[]>([]);
  const marqueeStateRef = useRef<MarqueeState | null>(null);
  const panStateRef = useRef<PanState | null>(null);
  const suppressClickRef = useRef(false);
  const latestRef = useRef({
    zoom,
    boardItems,
    selectedBoardItemIds,
    resolveBoardPoint,
    selectBoardItems,
    clearBoardSelection,
    raiseBoardItems,
    updateBoardItemPositions,
  });
  latestRef.current = {
    zoom,
    boardItems,
    selectedBoardItemIds,
    resolveBoardPoint,
    selectBoardItems,
    clearBoardSelection,
    raiseBoardItems,
    updateBoardItemPositions,
  };

  const autoPanDuringDrag = useCallback((event: PointerEvent) => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const rect = scroller.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    let dx = 0;
    let dy = 0;
    if (event.clientX - rect.left < AUTO_PAN_EDGE_SIZE) dx = -AUTO_PAN_STEP;
    else if (rect.right - event.clientX < AUTO_PAN_EDGE_SIZE) dx = AUTO_PAN_STEP;
    if (event.clientY - rect.top < AUTO_PAN_EDGE_SIZE) dy = -AUTO_PAN_STEP;
    else if (rect.bottom - event.clientY < AUTO_PAN_EDGE_SIZE) dy = AUTO_PAN_STEP;
    if (dx !== 0) scroller.scrollLeft += dx;
    if (dy !== 0) scroller.scrollTop += dy;
  }, [scrollRef]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.code !== "Space" || isEditableTarget(event.target)) return;
      event.preventDefault();
      setIsSpaceDown(true);
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.code !== "Space") return;
      setIsSpaceDown(false);
      setIsPanning(false);
      panStateRef.current = null;
    };
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, []);

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      const drag = dragStateRef.current;
      if (drag) {
        const moveX = event.clientX - drag.startClientX;
        const moveY = event.clientY - drag.startClientY;
        if (!drag.active && Math.hypot(moveX, moveY) < DRAG_ACTIVATION_DISTANCE) return;
        drag.active = true;
        autoPanDuringDrag(event);
        const scroller = scrollRef.current;
        const scrollX = scroller ? scroller.scrollLeft - drag.startScrollLeft : 0;
        const scrollY = scroller ? scroller.scrollTop - drag.startScrollTop : 0;
        const currentZoom = latestRef.current.zoom;
        const deltaX = (moveX + scrollX) / currentZoom;
        const deltaY = (moveY + scrollY) / currentZoom;
        const next = drag.items.map((item) => ({
          boardItemId: item.boardItemId,
          x: item.x + deltaX,
          y: item.y + deltaY,
        }));
        suppressClickRef.current = true;
        dragPreviewsRef.current = next;
        setDragPreviews(next);
        return;
      }

      const marquee = marqueeStateRef.current;
      if (marquee) {
        const current = latestRef.current.resolveBoardPoint(event.clientX, event.clientY);
        const rect = normalizeBoardRect(marquee.start, current);
        marquee.current = current;
        if (!marquee.active && Math.hypot(rect.width, rect.height) < MARQUEE_ACTIVATION_DISTANCE) return;
        marquee.active = true;
        suppressClickRef.current = true;
        setMarqueeRect(rect);
        return;
      }

      const pan = panStateRef.current;
      const scroller = scrollRef.current;
      if (pan && scroller) {
        scroller.scrollLeft = pan.scrollLeft - (event.clientX - pan.startClientX);
        scroller.scrollTop = pan.scrollTop - (event.clientY - pan.startClientY);
      }
    };

    const handlePointerUp = async () => {
      const drag = dragStateRef.current;
      if (drag) {
        if (!drag.active) {
          dragStateRef.current = null;
          dragPreviewsRef.current = [];
          setDragPreviews([]);
        } else {
          const previews = dragPreviewsRef.current.length > 0
            ? dragPreviewsRef.current
            : drag.items.map((item) => ({ boardItemId: item.boardItemId, x: item.x, y: item.y }));
          dragStateRef.current = null;
          dragPreviewsRef.current = [];
          setDragPreviews([]);
          latestRef.current.updateBoardItemPositions(snapBoardItemPositionUpdates(previews));
        }
      }
      const marquee = marqueeStateRef.current;
      if (marquee) {
        marqueeStateRef.current = null;
        setMarqueeRect(null);
        if (!marquee.active) {
          latestRef.current.clearBoardSelection();
        } else {
          const rect = normalizeBoardRect(marquee.start, marquee.current);
          const selectedIds = findBoardItemsInRect(latestRef.current.boardItems, rect);
          latestRef.current.selectBoardItems(selectedIds, selectedIds[selectedIds.length - 1] ?? null);
          latestRef.current.raiseBoardItems(selectedIds);
        }
      }
      panStateRef.current = null;
      setIsPanning(false);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [autoPanDuringDrag, scrollRef]);

  const handleCanvasPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || isBoardTileTarget(event.target)) return;
    const scroller = scrollRef.current;
    if (!scroller) return;
    if (!isSpaceDown && isInteractiveTarget(event.target)) return;
    event.preventDefault();
    if (!isSpaceDown) {
      const start = latestRef.current.resolveBoardPoint(event.clientX, event.clientY);
      marqueeStateRef.current = { start, current: start, active: false };
      setMarqueeRect(null);
      return;
    }
    panStateRef.current = {
      startClientX: event.clientX,
      startClientY: event.clientY,
      scrollLeft: scroller.scrollLeft,
      scrollTop: scroller.scrollTop,
    };
    setIsPanning(true);
  };

  const handleTilePointerDown = (event: ReactPointerEvent<HTMLButtonElement>, item: BoardWorkspaceItem) => {
    if (event.button !== 0 || isSpaceDown) return;
    event.stopPropagation();
    if (isBoardSelectionToggle(event)) {
      event.preventDefault();
      suppressClickRef.current = true;
      toggleBoardItemSelection(item.boardItemId);
      raiseBoardItems([item.boardItemId]);
      return;
    }
    const scroller = scrollRef.current;
    const dragItems = getDraggedBoardItems(boardItems, selectedBoardItemIds, item);
    if (!selectedBoardItemIds.has(item.boardItemId) || selectedBoardItemIds.size <= 1) {
      selectBoardItems([item.boardItemId], item.boardItemId);
    }
    raiseBoardItems(dragItems.map((dragItem) => dragItem.boardItemId));
    dragStateRef.current = {
      items: dragItems,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startScrollLeft: scroller?.scrollLeft ?? 0,
      startScrollTop: scroller?.scrollTop ?? 0,
      active: false,
    };
    dragPreviewsRef.current = [];
    suppressClickRef.current = false;
    setDragPreviews([]);
  };

  const shouldSuppressTileClick = () => {
    if (!suppressClickRef.current) return false;
    suppressClickRef.current = false;
    return true;
  };

  return {
    dragPreviews,
    marqueeRect,
    isPanning,
    isSpaceDown,
    handleCanvasPointerDown,
    handleTilePointerDown,
    shouldSuppressTileClick,
  };
}
