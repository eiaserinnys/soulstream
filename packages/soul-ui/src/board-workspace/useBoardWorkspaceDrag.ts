import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, RefObject } from "react";

import { toastManager } from "../components/ui/toast";
import { snapBoardPosition, type BoardWorkspaceItem } from "./board-workspace-items";

const DRAG_ACTIVATION_DISTANCE = 8;
const AUTO_PAN_EDGE_SIZE = 48;
const AUTO_PAN_STEP = 24;

interface DragState {
  item: BoardWorkspaceItem;
  startClientX: number;
  startClientY: number;
  startScrollLeft: number;
  startScrollTop: number;
  originX: number;
  originY: number;
  active: boolean;
}

interface PanState {
  startClientX: number;
  startClientY: number;
  scrollLeft: number;
  scrollTop: number;
}

interface UseBoardWorkspaceDragOptions {
  scrollRef: RefObject<HTMLDivElement | null>;
  updateBoardItemPosition: (boardItemId: string, x: number, y: number) => void;
  onUpdateBoardItemPosition?: (boardItemId: string, x: number, y: number) => Promise<void> | void;
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
}

function isBoardTileTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && Boolean(target.closest("[data-board-tile='true']"));
}

export function useBoardWorkspaceDrag({
  scrollRef,
  updateBoardItemPosition,
  onUpdateBoardItemPosition,
}: UseBoardWorkspaceDragOptions) {
  const [isSpaceDown, setIsSpaceDown] = useState(false);
  const [isPanning, setIsPanning] = useState(false);
  const [dragPreview, setDragPreview] = useState<{ boardItemId: string; x: number; y: number } | null>(null);
  const dragStateRef = useRef<DragState | null>(null);
  const dragPreviewRef = useRef<{ boardItemId: string; x: number; y: number } | null>(null);
  const panStateRef = useRef<PanState | null>(null);
  const suppressClickRef = useRef(false);

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
        const next = {
          boardItemId: drag.item.boardItemId,
          x: drag.originX + moveX + scrollX,
          y: drag.originY + moveY + scrollY,
        };
        suppressClickRef.current = true;
        dragPreviewRef.current = next;
        setDragPreview(next);
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
          dragPreviewRef.current = null;
          setDragPreview(null);
        } else {
          const preview = dragPreviewRef.current;
          const snapped = snapBoardPosition(preview?.x ?? drag.originX, preview?.y ?? drag.originY);
          dragStateRef.current = null;
          dragPreviewRef.current = null;
          setDragPreview(null);
          updateBoardItemPosition(drag.item.boardItemId, snapped.x, snapped.y);
          try {
            await onUpdateBoardItemPosition?.(drag.item.boardItemId, snapped.x, snapped.y);
          } catch (err) {
            updateBoardItemPosition(drag.item.boardItemId, drag.originX, drag.originY);
            toastManager.add({
              title: "Board position update failed",
              description: "The card was restored to its previous position.",
              type: "warning",
            });
            console.error("Board item position update failed:", err);
          }
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
  }, [autoPanDuringDrag, onUpdateBoardItemPosition, scrollRef, updateBoardItemPosition]);

  const handleCanvasPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!isSpaceDown || event.button !== 0 || isBoardTileTarget(event.target)) return;
    const scroller = scrollRef.current;
    if (!scroller) return;
    event.preventDefault();
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
    const scroller = scrollRef.current;
    dragStateRef.current = {
      item,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startScrollLeft: scroller?.scrollLeft ?? 0,
      startScrollTop: scroller?.scrollTop ?? 0,
      originX: item.x,
      originY: item.y,
      active: false,
    };
    dragPreviewRef.current = null;
    suppressClickRef.current = false;
    setDragPreview(null);
  };

  const shouldSuppressTileClick = () => {
    if (!suppressClickRef.current) return false;
    suppressClickRef.current = false;
    return true;
  };

  return {
    dragPreview,
    isPanning,
    isSpaceDown,
    handleCanvasPointerDown,
    handleTilePointerDown,
    shouldSuppressTileClick,
  };
}
