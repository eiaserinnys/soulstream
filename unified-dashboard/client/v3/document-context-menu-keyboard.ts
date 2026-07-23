import type { V3ContextMenuTarget } from "./V3ContextMenu";

interface ContextMenuKey {
  key: string;
  shiftKey: boolean;
}

interface ContextMenuBounds {
  left: number;
  bottom: number;
}

export function documentContextMenuTargetForKey(
  event: ContextMenuKey,
  bounds: ContextMenuBounds,
): V3ContextMenuTarget | null {
  const opensMenu = event.key === "ContextMenu"
    ? !event.shiftKey
    : event.key === "F10" && event.shiftKey;
  return opensMenu ? { x: bounds.left + 8, y: bounds.bottom - 8 } : null;
}
