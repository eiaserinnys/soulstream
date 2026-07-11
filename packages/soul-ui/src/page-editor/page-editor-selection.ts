export interface ContiguousBlockSelectionSnapshot {
  readonly anchorId: string | null;
  readonly focusId: string | null;
  readonly blockIds: readonly string[];
}

export interface ContiguousBlockSelection {
  getSnapshot(): ContiguousBlockSelectionSnapshot;
  select(blockId: string): void;
  extend(blockId: string): void;
  extendBy(delta: -1 | 1): void;
  replaceBlockOrder(blockIds: readonly string[]): void;
  clear(): void;
}

export function createContiguousBlockSelection(
  initialBlockIds: readonly string[],
): ContiguousBlockSelection {
  let blockIds = [...initialBlockIds];
  let anchorId: string | null = null;
  let focusId: string | null = null;

  const requireId = (blockId: string) => {
    if (!blockIds.includes(blockId)) throw new Error(`unknown editor block: ${blockId}`);
  };
  const snapshot = (): ContiguousBlockSelectionSnapshot => ({
    anchorId,
    focusId,
    blockIds: selectedIds(blockIds, anchorId, focusId),
  });

  return {
    getSnapshot: snapshot,
    select(blockId) {
      requireId(blockId);
      anchorId = blockId;
      focusId = blockId;
    },
    extend(blockId) {
      requireId(blockId);
      anchorId ??= blockId;
      focusId = blockId;
    },
    extendBy(delta) {
      if (blockIds.length === 0) return;
      if (focusId === null) {
        anchorId = blockIds[0]!;
        focusId = blockIds[0]!;
      }
      const currentIndex = blockIds.indexOf(focusId!);
      const nextIndex = Math.max(0, Math.min(blockIds.length - 1, currentIndex + delta));
      focusId = blockIds[nextIndex]!;
    },
    replaceBlockOrder(nextBlockIds) {
      blockIds = [...nextBlockIds];
      if (anchorId !== null && !blockIds.includes(anchorId)) anchorId = null;
      if (focusId !== null && !blockIds.includes(focusId)) focusId = anchorId;
    },
    clear() {
      anchorId = null;
      focusId = null;
    },
  };
}

export function selectedIds(
  blockIds: readonly string[],
  anchorId: string | null,
  focusId: string | null,
): readonly string[] {
  if (anchorId === null || focusId === null) return [];
  const anchor = blockIds.indexOf(anchorId);
  const focus = blockIds.indexOf(focusId);
  if (anchor < 0 || focus < 0) return [];
  return blockIds.slice(Math.min(anchor, focus), Math.max(anchor, focus) + 1);
}
