import { useRef } from "react";
import { Minus, Plus } from "lucide-react";

import { useGlassSurface } from "../components/LiquidGlassProvider";
import { useLiquidLens } from "../lib/liquid-lens";
import { formatBoardZoom } from "./board-viewport";

interface BoardWorkspaceZoomControlsProps {
  zoom: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
}

export function BoardWorkspaceZoomControls({
  zoom,
  onZoomIn,
  onZoomOut,
}: BoardWorkspaceZoomControlsProps) {
  const ref = useRef<HTMLDivElement>(null);
  const webglActive = useGlassSurface(ref, { enabled: true });
  useLiquidLens(ref, { scale: 18, enabled: !webglActive });

  return (
    <div
      ref={ref}
      className="pointer-events-auto absolute bottom-3 left-3 z-40 flex h-[38px] items-center gap-1 rounded-full border border-glass-border glass-strong glass-shadow-xs lg-rim px-1.5 text-xs font-semibold text-muted-foreground"
      data-liquid-glass-webgl={webglActive ? "true" : undefined}
      data-testid="board-zoom-controls"
    >
      <button
        type="button"
        className="flex h-7 w-7 items-center justify-center rounded-full transition-colors hover:bg-accent-blue/15 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-blue/50"
        title="Zoom out"
        aria-label="Zoom out"
        data-testid="board-zoom-out"
        onClick={onZoomOut}
      >
        <Minus className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
      <span data-testid="board-zoom-indicator" className="min-w-11 text-center">
        {formatBoardZoom(zoom)}
      </span>
      <button
        type="button"
        className="flex h-7 w-7 items-center justify-center rounded-full transition-colors hover:bg-accent-blue/15 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-blue/50"
        title="Zoom in"
        aria-label="Zoom in"
        data-testid="board-zoom-in"
        onClick={onZoomIn}
      >
        <Plus className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}
