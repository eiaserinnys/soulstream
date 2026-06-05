export function isBoardTileTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && Boolean(target.closest("[data-board-tile='true']"));
}
