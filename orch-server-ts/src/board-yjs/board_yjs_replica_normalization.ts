import type {
  BoardYjsReplica,
  CatalogBoardItemRow,
} from "./board_yjs_types.js";

export function normalizeMissingSourceTaskItemReferences(
  replica: BoardYjsReplica,
  existingSourceTaskItemIds: ReadonlySet<string>,
): BoardYjsReplica {
  let changed = false;
  const boardItems = replica.boardItems.map((item) => {
    const sourceTaskItemId = item.sourceTaskItemId;
    if (sourceTaskItemId === null || sourceTaskItemId === undefined ||
      existingSourceTaskItemIds.has(sourceTaskItemId)) {
      return item;
    }
    changed = true;
    return { ...item, sourceTaskItemId: null };
  });

  return changed ? { ...replica, boardItems } : replica;
}

export function findMissingSourceTaskItemReferences(
  boardItems: readonly CatalogBoardItemRow[],
  existingSourceTaskItemIds: ReadonlySet<string>,
): MissingSourceTaskItemReference[] {
  return boardItems.flatMap((item) => {
    const sourceTaskItemId = item.sourceTaskItemId;
    return sourceTaskItemId !== null && sourceTaskItemId !== undefined &&
        !existingSourceTaskItemIds.has(sourceTaskItemId)
      ? [{ boardItemId: item.id, sourceTaskItemId }]
      : [];
  }).sort((left, right) =>
    left.boardItemId.localeCompare(right.boardItemId) ||
    left.sourceTaskItemId.localeCompare(right.sourceTaskItemId)
  );
}

export interface MissingSourceTaskItemReference {
  boardItemId: string;
  sourceTaskItemId: string;
}
