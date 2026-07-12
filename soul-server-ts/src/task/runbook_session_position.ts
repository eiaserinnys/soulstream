export interface PositionedBoardItem {
  id?: string;
  itemId?: string;
  itemType?: string;
  x: number;
  y: number;
}

/** Preserve an idempotently upserted session card; allocate only when absent. */
export function sessionBoardItemPosition(
  boardItems: readonly PositionedBoardItem[],
  sessionId: string,
): [number, number] {
  const existing = boardItems.find((item) =>
    item.id === `session:${sessionId}`
    || (item.itemType === "session" && item.itemId === sessionId));
  return existing ? [existing.x, existing.y] : nextRunbookSessionPosition(boardItems);
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
