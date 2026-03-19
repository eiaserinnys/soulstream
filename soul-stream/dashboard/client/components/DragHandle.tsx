/**
 * DragHandle — 좌우 패널 리사이즈 핸들.
 */

import { useCallback, useRef, useEffect } from "react";

interface DragHandleProps {
  onResize: (deltaX: number) => void;
}

export function DragHandle({ onResize }: DragHandleProps) {
  const dragging = useRef(false);
  const lastX = useRef(0);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      dragging.current = true;
      lastX.current = e.clientX;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [],
  );

  useEffect(() => {
    function handleMouseMove(e: MouseEvent) {
      if (!dragging.current) return;
      const delta = e.clientX - lastX.current;
      lastX.current = e.clientX;
      onResize(delta);
    }

    function handleMouseUp() {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [onResize]);

  return (
    <div
      className="w-[5px] cursor-col-resize flex items-center justify-center shrink-0 transition-colors hover:bg-white/[0.04]"
      onMouseDown={handleMouseDown}
    >
      <div className="w-px h-8 bg-border rounded-sm" />
    </div>
  );
}
