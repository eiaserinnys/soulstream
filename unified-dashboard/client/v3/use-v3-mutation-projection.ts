import { useCallback, type Dispatch, type SetStateAction } from "react";
import { retainEqualValue } from "@seosoyoung/soul-ui";
import type { PageDto } from "@seosoyoung/soul-ui/page";

import type { PlannerFolder } from "./planner-data";
import { movePlannerSession, removePlannerSessions } from "./planner-mutation-projection";

export function useV3MutationProjection({
  patchLoadedFolder,
  removeLoadedSessions,
  moveLoadedSession,
  moveLoadedFolderParent,
  removeRunHistorySessions,
  moveRunHistorySession,
  setSelectedFolderSnapshot,
}: {
  patchLoadedFolder(folderId: string, update: (task: PlannerFolder) => PlannerFolder): void;
  removeLoadedSessions(sessionIds: readonly string[]): void;
  moveLoadedSession(sessionId: string, targetFolderId: string): void;
  moveLoadedFolderParent(task: PlannerFolder, targetFolderId: string | null): void;
  removeRunHistorySessions(sessionIds: readonly string[]): void;
  moveRunHistorySession(sessionId: string, targetFolderId: string): void;
  setSelectedFolderSnapshot: Dispatch<SetStateAction<PlannerFolder | null>>;
}) {
  const patchPlannerFolder = useCallback((folderId: string, update: (task: PlannerFolder) => PlannerFolder) => {
    patchLoadedFolder(folderId, update);
    setSelectedFolderSnapshot((current) => current?.page.id === folderId
      ? retainEqualValue(current, update(current))
      : current);
  }, [patchLoadedFolder, setSelectedFolderSnapshot]);

  const removeSessionsFromPlanner = useCallback((sessionIds: readonly string[]) => {
    removeLoadedSessions(sessionIds);
    removeRunHistorySessions(sessionIds);
    const removed = new Set(sessionIds);
    setSelectedFolderSnapshot((current) => current
      ? removePlannerSessions([current], removed)[0] ?? current
      : current);
  }, [removeLoadedSessions, removeRunHistorySessions, setSelectedFolderSnapshot]);

  const moveSessionInPlanner = useCallback((sessionId: string, targetFolderId: string) => {
    moveLoadedSession(sessionId, targetFolderId);
    moveRunHistorySession(sessionId, targetFolderId);
    setSelectedFolderSnapshot((current) => current
      ? movePlannerSession([current], sessionId, targetFolderId)[0] ?? current
      : current);
  }, [moveLoadedSession, moveRunHistorySession, setSelectedFolderSnapshot]);

  const moveFolderParentInPlanner = useCallback((task: PlannerFolder, targetFolderId: string | null) => {
    moveLoadedFolderParent(task, targetFolderId);
    setSelectedFolderSnapshot((current) => current?.page.id === task.page.id
      ? retainEqualValue(current, { ...current, parentFolderId: targetFolderId })
      : current);
  }, [moveLoadedFolderParent, setSelectedFolderSnapshot]);

  return { patchPlannerFolder, removeSessionsFromPlanner, moveSessionInPlanner, moveFolderParentInPlanner };
}
