import type {
  BoardYjsReplica,
  CatalogBoardItemRow,
} from "./board_yjs_types.js";

export function normalizeMissingSourceChecklistItemReferences(
  replica: BoardYjsReplica,
  existingSourceChecklistItemIds: ReadonlySet<string>,
): BoardYjsReplica {
  let changed = false;
  const boardItems = replica.boardItems.map((item) => {
    const sourceChecklistItemId = item.sourceChecklistItemId;
    if (sourceChecklistItemId === null || sourceChecklistItemId === undefined ||
      existingSourceChecklistItemIds.has(sourceChecklistItemId)) {
      return item;
    }
    changed = true;
    return { ...item, sourceChecklistItemId: null };
  });

  return changed ? { ...replica, boardItems } : replica;
}

export function findMissingSourceChecklistItemReferences(
  boardItems: readonly CatalogBoardItemRow[],
  existingSourceChecklistItemIds: ReadonlySet<string>,
): MissingSourceChecklistItemReference[] {
  return boardItems.flatMap((item) => {
    const sourceChecklistItemId = item.sourceChecklistItemId;
    return sourceChecklistItemId !== null && sourceChecklistItemId !== undefined &&
        !existingSourceChecklistItemIds.has(sourceChecklistItemId)
      ? [{ boardItemId: item.id, sourceChecklistItemId }]
      : [];
  }).sort((left, right) =>
    left.boardItemId.localeCompare(right.boardItemId) ||
    left.sourceChecklistItemId.localeCompare(right.sourceChecklistItemId)
  );
}

export interface MissingSourceChecklistItemReference {
  boardItemId: string;
  sourceChecklistItemId: string;
}
