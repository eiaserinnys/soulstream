import type { BoardYjsReplica } from "./board_yjs_types.js";

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
