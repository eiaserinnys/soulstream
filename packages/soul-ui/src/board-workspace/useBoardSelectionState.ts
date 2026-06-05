import { useCallback, useRef, useState } from "react";

export function useBoardSelectionState() {
  const [selectedBoardItemIds, setSelectedBoardItemIds] = useState<Set<string>>(() => new Set());
  const [primarySelectedBoardItemId, setPrimarySelectedBoardItemId] = useState<string | null>(null);
  const [zOrderByBoardItemId, setZOrderByBoardItemId] = useState<Map<string, number>>(() => new Map());
  const zOrderCounterRef = useRef(0);

  const selectBoardItems = useCallback((boardItemIds: string[], primaryBoardItemId: string | null) => {
    setSelectedBoardItemIds(new Set(boardItemIds));
    setPrimarySelectedBoardItemId(primaryBoardItemId);
  }, []);

  const selectSingleBoardItem = useCallback((boardItemId: string) => {
    selectBoardItems([boardItemId], boardItemId);
  }, [selectBoardItems]);

  const clearBoardSelection = useCallback(() => {
    selectBoardItems([], null);
  }, [selectBoardItems]);

  const toggleBoardItemSelection = useCallback((boardItemId: string) => {
    setSelectedBoardItemIds((previous) => {
      const next = new Set(previous);
      if (next.has(boardItemId)) next.delete(boardItemId);
      else next.add(boardItemId);
      const nextIds = Array.from(next);
      setPrimarySelectedBoardItemId(next.has(boardItemId) ? boardItemId : nextIds[nextIds.length - 1] ?? null);
      return next;
    });
  }, []);

  const raiseBoardItems = useCallback((boardItemIds: string[]) => {
    if (boardItemIds.length === 0) return;
    setZOrderByBoardItemId((previous) => {
      const next = new Map(previous);
      for (const boardItemId of boardItemIds) {
        next.set(boardItemId, ++zOrderCounterRef.current);
      }
      return next;
    });
  }, []);

  const getBoardItemZIndex = useCallback((boardItemId: string) => {
    return 10 + (zOrderByBoardItemId.get(boardItemId) ?? 0);
  }, [zOrderByBoardItemId]);

  return {
    selectedBoardItemIds,
    primarySelectedBoardItemId,
    selectBoardItems,
    selectSingleBoardItem,
    clearBoardSelection,
    toggleBoardItemSelection,
    raiseBoardItems,
    getBoardItemZIndex,
  };
}
