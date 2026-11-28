import { useCallback, type Dispatch, type SetStateAction } from "react";
import { retainEqualValue } from "@seosoyoung/soul-ui";

import type { PlannerFolder } from "./planner-data";
import { movePlannerSession, removePlannerSessions } from "./planner-mutation-projection";

export function useV3MutationProjection({
  removeRunHistorySessions,
  moveRunHistorySession,
  setSelectedFolderSnapshot,
}: {
  removeRunHistorySessions(sessionIds: readonly string[]): void;
  moveRunHistorySession(sessionId: string, targetFolderId: string): void;
  setSelectedFolderSnapshot: Dispatch<SetStateAction<PlannerFolder | null>>;
}) {
  const patchPlannerFolder = useCallback((folderId: string, update: (task: PlannerFolder) => PlannerFolder) => {
    setSelectedFolderSnapshot((current) => current?.page.id === folderId
      ? retainEqualValue(current, update(current))
      : current);
  }, [setSelectedFolderSnapshot]);

  const removeSessionsFromPlanner = useCallback((sessionIds: readonly string[]) => {
    removeRunHistorySessions(sessionIds);
    const removed = new Set(sessionIds);
    setSelectedFolderSnapshot((current) => current
      ? removePlannerSessions([current], removed)[0] ?? current
      : current);
  }, [removeRunHistorySessions, setSelectedFolderSnapshot]);

  const moveSessionInPlanner = useCallback((sessionId: string, targetFolderId: string) => {
    moveRunHistorySession(sessionId, targetFolderId);
    setSelectedFolderSnapshot((current) => current
      ? movePlannerSession([current], sessionId, targetFolderId)[0] ?? current
      : current);
  }, [moveRunHistorySession, setSelectedFolderSnapshot]);

  const moveFolderParentInPlanner = useCallback((task: PlannerFolder, targetFolderId: string | null) => {
    setSelectedFolderSnapshot((current) => current?.page.id === task.page.id
      ? retainEqualValue(current, { ...current, parentFolderId: targetFolderId })
      : current);
  }, [setSelectedFolderSnapshot]);

  return { patchPlannerFolder, removeSessionsFromPlanner, moveSessionInPlanner, moveFolderParentInPlanner };
}
