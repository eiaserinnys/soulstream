export interface PositionedBoardItem {
  x: number;
  y: number;
}

/** Existing runbook placement policy shared by initial projection and durable replay. */
export function nextRunbookSessionPosition(
  boardItems: readonly PositionedBoardItem[],
): [number, number] {
  const occupied = new Set(boardItems.map((item) => `${item.x}:${item.y}`));
  let index = 4;
  while (true) {
    const x = (index % 4) * 280;
    const y = Math.floor(index / 4) * 160;
    if (!occupied.has(`${x}:${y}`)) return [x, y];
    index += 1;
  }
}
