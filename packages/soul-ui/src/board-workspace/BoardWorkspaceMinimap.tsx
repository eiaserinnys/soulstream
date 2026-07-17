import { useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { DisclosureActionIcon } from "../components/DisclosureActionIcon";
import { Button } from "../components/ui/button";
import { useGlassSurface } from "../components/LiquidGlassProvider";
import { cn } from "../lib/cn";
import { useLiquidLens } from "../lib/liquid-lens";
import {
  getBoardItemHeight,
  getBoardItemWidth,
  type BoardWorkspaceItem,
} from "./board-workspace-items";
import { formatBoardZoom, getViewportBoardRect, type BoardViewport } from "./board-viewport";
import type { BoardPoint, BoardRect } from "./board-selection";

const MINIMAP_WIDTH = 192;
const MINIMAP_HEIGHT = 128;
const MINIMAP_PADDING = 8;
const MINIMAP_BOUNDS_PADDING = 420;

interface BoardWorkspaceMinimapProps {
  boardItems: BoardWorkspaceItem[];
  zoom: number;
  viewport: BoardViewport;
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  onMoveViewport: (point: BoardPoint) => void;
}

interface MinimapProjection {
  bounds: BoardRect;
  viewportRect: BoardRect;
  scale: number;
}

function buildProjection(boardItems: BoardWorkspaceItem[], viewport: BoardViewport, zoom: number): MinimapProjection {
  const viewportRect = getViewportBoardRect(viewport, zoom);
  const xs = [viewportRect.x, viewportRect.x + viewportRect.width];
  const ys = [viewportRect.y, viewportRect.y + viewportRect.height];
  for (const item of boardItems) {
    xs.push(item.x, item.x + getBoardItemWidth(item));
    ys.push(item.y, item.y + getBoardItemHeight(item));
  }
  const minX = Math.min(...xs) - MINIMAP_BOUNDS_PADDING;
  const minY = Math.min(...ys) - MINIMAP_BOUNDS_PADDING;
  const maxX = Math.max(...xs) + MINIMAP_BOUNDS_PADDING;
  const maxY = Math.max(...ys) + MINIMAP_BOUNDS_PADDING;
  const bounds = {
    x: minX,
    y: minY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY),
  };
  return {
    bounds,
    viewportRect,
    scale: Math.min(
      (MINIMAP_WIDTH - MINIMAP_PADDING * 2) / bounds.width,
      (MINIMAP_HEIGHT - MINIMAP_PADDING * 2) / bounds.height,
    ),
  };
}

function projectRect(rect: BoardRect, projection: MinimapProjection): BoardRect {
  return {
    x: MINIMAP_PADDING + (rect.x - projection.bounds.x) * projection.scale,
    y: MINIMAP_PADDING + (rect.y - projection.bounds.y) * projection.scale,
    width: Math.max(3, rect.width * projection.scale),
    height: Math.max(3, rect.height * projection.scale),
  };
}

export function BoardWorkspaceMinimap({
  boardItems,
  zoom,
  viewport,
  collapsed,
  onCollapsedChange,
  onMoveViewport,
}: BoardWorkspaceMinimapProps) {
  const capsuleRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const projection = useMemo(() => buildProjection(boardItems, viewport, zoom), [boardItems, viewport, zoom]);
  const viewportMiniRect = projectRect(projection.viewportRect, projection);
  const webglActive = useGlassSurface(capsuleRef, { enabled: true });
  useLiquidLens(capsuleRef, { scale: 18, enabled: !webglActive });

  const moveFromPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const miniX = event.clientX - rect.left;
    const miniY = event.clientY - rect.top;
    onMoveViewport({
      x: projection.bounds.x + (miniX - MINIMAP_PADDING) / projection.scale,
      y: projection.bounds.y + (miniY - MINIMAP_PADDING) / projection.scale,
    });
  };

  if (collapsed) {
    return (
      <div
        ref={capsuleRef}
        className="pointer-events-auto absolute bottom-3 right-3 z-40 flex items-center gap-2 rounded-full border border-glass-border glass-strong glass-shadow-xs lg-rim px-2 py-1"
        data-liquid-glass-webgl={webglActive ? "true" : undefined}
      >
        <span data-testid="board-zoom-indicator" className="min-w-11 text-center text-xs font-medium text-muted-foreground">
          {formatBoardZoom(zoom)}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          data-testid="board-minimap-toggle"
          title="Show minimap"
          aria-expanded={false}
          onClick={() => onCollapsedChange(false)}
        >
          <DisclosureActionIcon expanded={false} className="h-4 w-4" />
        </Button>
      </div>
    );
  }

  return (
    <div
      ref={capsuleRef}
      className="pointer-events-auto absolute bottom-3 right-3 z-40 rounded-[14px] border border-glass-border glass-strong glass-shadow-md lg-rim p-2"
      data-liquid-glass-webgl={webglActive ? "true" : undefined}
    >
      <div className="mb-1 flex items-center justify-between gap-2">
        <span data-testid="board-zoom-indicator" className="text-xs font-medium text-muted-foreground">
          {formatBoardZoom(zoom)}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          data-testid="board-minimap-toggle"
          title="Hide minimap"
          aria-expanded
          onClick={() => onCollapsedChange(true)}
        >
          <DisclosureActionIcon expanded className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div
        data-testid="board-minimap"
        className={cn(
          "relative overflow-hidden rounded-[10px] border border-[var(--lg-line)] bg-muted/40",
          dragging && "cursor-grabbing",
          !dragging && "cursor-crosshair",
        )}
        style={{ width: MINIMAP_WIDTH, height: MINIMAP_HEIGHT }}
        onPointerDown={(event) => {
          event.preventDefault();
          event.currentTarget.setPointerCapture?.(event.pointerId);
          setDragging(true);
          moveFromPointer(event);
        }}
        onPointerMove={(event) => {
          if (dragging) moveFromPointer(event);
        }}
        onPointerUp={() => setDragging(false)}
        onPointerCancel={() => setDragging(false)}
      >
        {boardItems.map((item) => {
          const rect = projectRect({
            x: item.x,
            y: item.y,
            width: getBoardItemWidth(item),
            height: getBoardItemHeight(item),
          }, projection);
          return (
            <div
              key={item.boardItemId}
              className="absolute rounded-[2.5px] bg-muted-foreground/40"
              style={{
                left: rect.x,
                top: rect.y,
                width: rect.width,
                height: rect.height,
              }}
            />
          );
        })}
        <div
          data-testid="board-minimap-viewport"
          className="absolute rounded border-[1.5px] border-accent-blue bg-accent-blue/8"
          style={{
            left: viewportMiniRect.x,
            top: viewportMiniRect.y,
            width: viewportMiniRect.width,
            height: viewportMiniRect.height,
          }}
        />
      </div>
    </div>
  );
}
