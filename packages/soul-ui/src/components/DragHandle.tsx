/**
 * DragHandle - 패널 간 리사이즈를 위한 드래그 핸들
 *
 * 마우스 드래그로 좌우 패널 크기를 조절합니다.
 * deltaPercent = (dx / viewportWidth) * 100 으로 환산하여 콜백에 전달합니다.
 */

import { useCallback, useRef } from "react";

export interface DragHandleProps {
  onDrag: (deltaPercent: number) => void;
}

export function DragHandle({ onDrag }: DragHandleProps) {
  const dragging = useRef(false);
  const lastX = useRef(0);
  const onDragRef = useRef(onDrag);
  onDragRef.current = onDrag;

  const lineRef = useRef<HTMLDivElement>(null);

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      dragging.current = true;
      lastX.current = e.clientX;

      const onMouseMove = (ev: MouseEvent) => {
        if (!dragging.current) return;
        const dx = ev.clientX - lastX.current;
        lastX.current = ev.clientX;
        const containerWidth = document.documentElement.clientWidth;
        if (containerWidth > 0) {
          onDragRef.current((dx / containerWidth) * 100);
        }
      };

      const onMouseUp = () => {
        dragging.current = false;
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [],
  );

  return (
    <div
      onMouseDown={onMouseDown}
      className="w-1 cursor-col-resize bg-transparent shrink-0 relative z-10"
    >
      <div
        className="absolute inset-y-0 -left-[3px] -right-[3px]"
        onMouseEnter={() => {
          if (lineRef.current) {
            lineRef.current.style.backgroundColor = "var(--node-user)";
            lineRef.current.style.opacity = "0.5";
          }
        }}
        onMouseLeave={() => {
          if (lineRef.current) {
            lineRef.current.style.backgroundColor = "var(--border)";
            lineRef.current.style.opacity = "1";
          }
        }}
      >
        <div
          ref={lineRef}
          className="absolute inset-y-0 left-[3px] w-px transition-colors duration-150 bg-border"
        />
      </div>
    </div>
  );
}
