import { boardRectsIntersect, type BoardRect } from "./board-selection";
import { getViewportBoardRect, type BoardViewport } from "./board-viewport";
import {
  BOARD_CANVAS_ORIGIN_X,
  BOARD_CANVAS_ORIGIN_Y,
  BOARD_TILE_HEIGHT,
  BOARD_TILE_WIDTH,
  snapBoardPosition,
  type BoardWorkspaceItem,
} from "./board-workspace-items";

export interface BoardSpawnOptions {
  viewport: BoardViewport;
  zoom: number;
  maxAttempts?: number;
  random?: () => number;
}

const DEFAULT_MAX_ATTEMPTS = 50;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

export function getFallbackBoardSpawnViewport(zoom: number): BoardViewport {
  return {
    scrollLeft: (BOARD_CANVAS_ORIGIN_X - 80) * zoom,
    scrollTop: (BOARD_CANVAS_ORIGIN_Y - 60) * zoom,
    width: typeof window === "undefined" ? 1024 : window.innerWidth,
    height: typeof window === "undefined" ? 768 : window.innerHeight,
  };
}

function getTileRect(position: { x: number; y: number }): BoardRect {
  return {
    x: position.x,
    y: position.y,
    width: BOARD_TILE_WIDTH,
    height: BOARD_TILE_HEIGHT,
  };
}

function getBasePosition(viewportRect: BoardRect): { x: number; y: number } {
  return snapBoardPosition(
    viewportRect.x + viewportRect.width / 2 - BOARD_TILE_WIDTH / 2,
    viewportRect.y + viewportRect.height / 2 - BOARD_TILE_HEIGHT / 2,
  );
}

function viewportCanFitTile(viewportRect: BoardRect): boolean {
  return viewportRect.width >= BOARD_TILE_WIDTH && viewportRect.height >= BOARD_TILE_HEIGHT;
}

function isInsideViewport(position: { x: number; y: number }, viewportRect: BoardRect): boolean {
  return (
    position.x >= viewportRect.x &&
    position.y >= viewportRect.y &&
    position.x + BOARD_TILE_WIDTH <= viewportRect.x + viewportRect.width &&
    position.y + BOARD_TILE_HEIGHT <= viewportRect.y + viewportRect.height
  );
}

function collidesWithAny(
  position: { x: number; y: number },
  items: readonly BoardWorkspaceItem[],
): boolean {
  const candidateRect = getTileRect(position);
  return items.some((item) =>
    boardRectsIntersect(candidateRect, {
      x: item.x,
      y: item.y,
      width: BOARD_TILE_WIDTH,
      height: BOARD_TILE_HEIGHT,
    }),
  );
}

function findCandidate(
  base: { x: number; y: number },
  attempt: number,
): { x: number; y: number } {
  if (attempt === 0) return base;
  const radius = (BOARD_TILE_WIDTH / 2) * Math.sqrt(attempt);
  const angle = attempt * GOLDEN_ANGLE;
  return snapBoardPosition(
    base.x + Math.cos(angle) * radius,
    base.y + Math.sin(angle) * radius,
  );
}

function fallbackPosition(
  base: { x: number; y: number },
  random: () => number,
): { x: number; y: number } {
  const offsetX = (random() * 2 - 1) * (BOARD_TILE_WIDTH / 2);
  const offsetY = (random() * 2 - 1) * (BOARD_TILE_WIDTH / 2);
  return snapBoardPosition(base.x + offsetX, base.y + offsetY);
}

export function findOpenBoardPositionInViewport(
  items: readonly BoardWorkspaceItem[],
  options: BoardSpawnOptions,
): { x: number; y: number } {
  const viewportRect = getViewportBoardRect(options.viewport, options.zoom);
  const base = getBasePosition(viewportRect);
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const canFit = viewportCanFitTile(viewportRect);

  if (!canFit) {
    return fallbackPosition(base, options.random ?? Math.random);
  }

  for (let attempt = 0; attempt <= maxAttempts; attempt += 1) {
    const candidate = findCandidate(base, attempt);
    if (!isInsideViewport(candidate, viewportRect)) continue;
    if (!collidesWithAny(candidate, items)) return candidate;
  }

  return fallbackPosition(base, options.random ?? Math.random);
}
