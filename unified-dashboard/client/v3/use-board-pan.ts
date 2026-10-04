import { useRef, type HTMLAttributes, type PointerEvent } from "react";

/** Mouse/pen browsing; touch keeps the browser's two-axis overflow gesture. */
export function useBoardPan(): HTMLAttributes<HTMLDivElement> {
  const pointer = useRef<{ id: number; x: number; y: number; scroll: number; active: boolean } | null>(null);
  const suppressClick = useRef(false);
  const finish = (event: PointerEvent<HTMLDivElement>) => {
    if (pointer.current?.id !== event.pointerId) return;
    pointer.current = null;
    event.currentTarget.classList.remove("is-panning");
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  return {
    onPointerDown(event) {
      suppressClick.current = false; pointer.current = null;
      // Footer controls own clicks. Paper body/footer can pan.
      const target = event.target as Element;
      if (event.button !== 0 || event.pointerType === "touch" || event.currentTarget.scrollWidth <= event.currentTarget.clientWidth
        || target.closest("input, textarea, a")
        || target.closest("button") && !target.closest(".v3-postit-open")) return;
      pointer.current = { id: event.pointerId, x: event.clientX, y: event.clientY, scroll: event.currentTarget.scrollLeft, active: false };
    },
    onPointerMove(event) {
      const start = pointer.current;
      if (!start || start.id !== event.pointerId) return;
      const x = event.clientX - start.x, y = event.clientY - start.y;
      if (!start.active) {
        if (Math.abs(y) > 8 && Math.abs(y) >= Math.abs(x)) { pointer.current = null; return; }
        if (Math.abs(x) <= 8) return;
        start.active = true; suppressClick.current = true;
        event.currentTarget.setPointerCapture(event.pointerId);
        event.currentTarget.classList.add("is-panning");
        window.getSelection()?.removeAllRanges();
      }
      event.preventDefault();
      event.currentTarget.scrollLeft = start.scroll - x;
    },
    onPointerUp: finish, onPointerCancel: finish, onLostPointerCapture: finish,
    onClickCapture(event) {
      if (suppressClick.current) { suppressClick.current = false; event.preventDefault(); event.stopPropagation(); }
    },
    onDragStartCapture(event) { if (pointer.current) event.preventDefault(); },
  };
}
