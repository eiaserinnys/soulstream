import type { CSSProperties } from "react";

import {
  BOARD_CANVAS_HEIGHT,
  BOARD_CANVAS_ORIGIN_X,
  BOARD_CANVAS_ORIGIN_Y,
  BOARD_CANVAS_WIDTH,
} from "./board-workspace-items";
import type { BoardPoint, BoardRect } from "./board-selection";

export const MIN_BOARD_ZOOM = 0.25;
export const MAX_BOARD_ZOOM = 2;
export const DEFAULT_BOARD_ZOOM = 1;
const BOARD_DOT_GRID_SIZE = 22;

export interface BoardViewport {
  scrollLeft: number;
  scrollTop: number;
  width: number;
  height: number;
}

export function clampBoardZoom(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_BOARD_ZOOM;
  return Math.min(MAX_BOARD_ZOOM, Math.max(MIN_BOARD_ZOOM, Number(value.toFixed(2))));
}

export function formatBoardZoom(zoom: number): string {
  return `${Math.round(zoom * 100)}%`;
}

export function getBoardGridStyle(zoom: number): CSSProperties {
  const safeZoom = clampBoardZoom(zoom);
  const scaledGridSize = BOARD_DOT_GRID_SIZE / safeZoom;
  const alpha = zoom < 0.5 ? 0.16 : zoom < 0.75 ? 0.22 : zoom > 1.4 ? 0.26 : 0.32;
  const dotColor = `color-mix(in srgb, var(--muted-foreground) ${Math.round(alpha * 100)}%, transparent)`;
  const dotOffset = scaledGridSize / 2;
  return {
    backgroundColor: "var(--lg-card)",
    backgroundImage: `radial-gradient(circle, ${dotColor} 1px, transparent 1.4px)`,
    backgroundSize: `${scaledGridSize}px ${scaledGridSize}px`,
    backgroundPosition: `${dotOffset}px ${dotOffset}px`,
  };
}

export function getCanvasBoardPoint(clientX: number, clientY: number, canvas: HTMLElement, zoom: number): BoardPoint {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (clientX - rect.left) / zoom - BOARD_CANVAS_ORIGIN_X,
    y: (clientY - rect.top) / zoom - BOARD_CANVAS_ORIGIN_Y,
  };
}

export function readBoardViewport(scroller: HTMLElement): BoardViewport {
  return {
    scrollLeft: scroller.scrollLeft,
    scrollTop: scroller.scrollTop,
    width: scroller.clientWidth,
    height: scroller.clientHeight,
  };
}

export function getViewportBoardRect(viewport: BoardViewport, zoom: number): BoardRect {
  return {
    x: viewport.scrollLeft / zoom - BOARD_CANVAS_ORIGIN_X,
    y: viewport.scrollTop / zoom - BOARD_CANVAS_ORIGIN_Y,
    width: viewport.width / zoom,
    height: viewport.height / zoom,
  };
}

export function setScrollerZoomAroundClientPoint(
  scroller: HTMLElement,
  canvas: HTMLElement,
  currentZoom: number,
  nextZoom: number,
  clientX: number,
  clientY: number,
): void {
  const scrollerRect = scroller.getBoundingClientRect();
  const boardPoint = getCanvasBoardPoint(clientX, clientY, canvas, currentZoom);
  scroller.scrollLeft = (BOARD_CANVAS_ORIGIN_X + boardPoint.x) * nextZoom - (clientX - scrollerRect.left);
  scroller.scrollTop = (BOARD_CANVAS_ORIGIN_Y + boardPoint.y) * nextZoom - (clientY - scrollerRect.top);
}

export function centerBoardPointInScroller(
  scroller: HTMLElement,
  boardPoint: BoardPoint,
  zoom: number,
): void {
  scroller.scrollLeft = (BOARD_CANVAS_ORIGIN_X + boardPoint.x) * zoom - scroller.clientWidth / 2;
  scroller.scrollTop = (BOARD_CANVAS_ORIGIN_Y + boardPoint.y) * zoom - scroller.clientHeight / 2;
}

export function getScaledCanvasSize(zoom: number): CSSProperties {
  return {
    width: BOARD_CANVAS_WIDTH * zoom,
    height: BOARD_CANVAS_HEIGHT * zoom,
  };
}
