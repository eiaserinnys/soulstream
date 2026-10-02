import { useRef } from 'react';
import { Platform, type ViewProps } from 'react-native';
import { BOARD_DRAG_SLOP, BOARD_LONG_PRESS_MS } from '../../lib/card-board-layout';

/** Touch stays with ScrollView; quick mouse motion browses before the longpress DnD. */
export function useBoardPointerPan({ getX, max, dragging, move }: { getX(): number; max: number; dragging: boolean; move(x: number): void }) {
  const latest = useRef({ getX, max, dragging, move }); latest.current = { getX, max, dragging, move };
  const pointer = useRef<{ id: number; x: number; y: number; offset: number; active: boolean } | null>(null);
  const suppressUntil = useRef(0);
  const finish: NonNullable<ViewProps['onPointerUp']> = (event) => {
    if (pointer.current?.id !== event.nativeEvent.pointerId) return;
    if (pointer.current.active) suppressUntil.current = Date.now() + BOARD_LONG_PRESS_MS;
    pointer.current = null;
  };
  const handlers: ViewProps = {
    onPointerDown(event) {
      const value = event.nativeEvent;
      if (value.pointerType !== 'mouse' || value.button !== 0 || latest.current.max <= 0 || latest.current.dragging) return;
      pointer.current = { id: value.pointerId, x: value.pageX, y: value.pageY, offset: latest.current.getX(), active: false };
    },
    onPointerMove(event) {
      const start = pointer.current, value = event.nativeEvent;
      if (!start || start.id !== value.pointerId || latest.current.dragging) return;
      const dx = value.pageX - start.x, dy = value.pageY - start.y;
      if (!start.active) {
        if (Math.abs(dy) > BOARD_DRAG_SLOP && Math.abs(dy) >= Math.abs(dx)) { pointer.current = null; return; }
        if (Math.abs(dx) <= BOARD_DRAG_SLOP) return;
        start.active = true; suppressUntil.current = Infinity;
        if (Platform.OS === 'web') {
          // Native ScrollView/RNGH own native delivery; DOM capture follows a mouse outside the board.
          (event.currentTarget as unknown as { setPointerCapture?(id: number): void }).setPointerCapture?.(value.pointerId);
        }
      }
      event.preventDefault(); latest.current.move(start.offset - dx);
    },
    onPointerUp: finish, onPointerCancel: finish,
  };
  return { handlers, canPress: () => Date.now() >= suppressUntil.current };
}
