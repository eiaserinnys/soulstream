import { useCallback, useEffect, useMemo, useState } from "react";

import type { SessionParentRef, BoardSessionRelationIndex, DirectChildPortalItem } from "./board-session-relations";
import { getDirectChildPortalItems } from "./board-session-relations";
import type { BoardWorkspaceItem, SessionBoardWorkspaceItem } from "./board-workspace-items";

interface UseBoardChildStackStateParams {
  boardItems: BoardWorkspaceItem[];
  relationIndex: BoardSessionRelationIndex | null;
  selectedFolderId: string | null;
  selectFolder: (folderId: string | null) => void;
}

export function useBoardChildStackState({
  boardItems,
  relationIndex,
  selectedFolderId,
  selectFolder,
}: UseBoardChildStackStateParams) {
  const [expandedStackParentId, setExpandedStackParentId] = useState<string | null>(null);
  const [pulseBoardItemId, setPulseBoardItemId] = useState<string | null>(null);

  useEffect(() => {
    if (!expandedStackParentId) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExpandedStackParentId(null);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [expandedStackParentId]);

  useEffect(() => {
    if (!pulseBoardItemId) return;
    const timeout = window.setTimeout(() => setPulseBoardItemId(null), 900);
    return () => window.clearTimeout(timeout);
  }, [pulseBoardItemId]);

  const toggleChildStack = useCallback((item: SessionBoardWorkspaceItem) => {
    setExpandedStackParentId((current) =>
      current === item.session.agentSessionId ? null : item.session.agentSessionId,
    );
  }, []);

  const closeChildStack = useCallback(() => setExpandedStackParentId(null), []);

  const pulseInFolder = useCallback((folderId: string | null, boardItemId: string) => {
    selectFolder(folderId);
    setExpandedStackParentId(null);
    setPulseBoardItemId(boardItemId);
  }, [selectFolder]);

  const openChildRef = useCallback((child: DirectChildPortalItem) => {
    pulseInFolder(child.folderId, `session:${child.session.agentSessionId}`);
  }, [pulseInFolder]);

  const navigateToParent = useCallback((parentRef: SessionParentRef) => {
    if (!parentRef.parentAvailable) return;
    pulseInFolder(parentRef.parentFolderId, `session:${parentRef.parentSessionId}`);
  }, [pulseInFolder]);

  const expandedParentItem = useMemo(() => {
    if (!expandedStackParentId) return null;
    const item = boardItems.find((candidate): candidate is SessionBoardWorkspaceItem =>
      candidate.type === "session" && candidate.session.agentSessionId === expandedStackParentId,
    );
    return item ?? null;
  }, [boardItems, expandedStackParentId]);

  const expandedChildren = useMemo(() => {
    if (!expandedStackParentId || !relationIndex) return [];
    return getDirectChildPortalItems(relationIndex, expandedStackParentId, selectedFolderId);
  }, [expandedStackParentId, relationIndex, selectedFolderId]);

  return {
    expandedStackParentId,
    expandedParentItem,
    expandedChildren,
    pulseBoardItemId,
    closeChildStack,
    toggleChildStack,
    openChildRef,
    navigateToParent,
  };
}
