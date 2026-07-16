import { useCallback, type Dispatch, type SetStateAction } from "react";
import { retainEqualValue } from "@seosoyoung/soul-ui";

import type { PlannerTask } from "./planner-data";
import { movePlannerSession, removePlannerSessions } from "./planner-mutation-projection";

export function useV3MutationProjection({
  patchLoadedTask,
  removeLoadedSessions,
  moveLoadedSession,
  removeRunHistorySessions,
  moveRunHistorySession,
  setSelectedTaskSnapshot,
}: {
  patchLoadedTask(taskId: string, update: (task: PlannerTask) => PlannerTask): void;
  removeLoadedSessions(sessionIds: readonly string[]): void;
  moveLoadedSession(sessionId: string, targetTaskId: string): void;
  removeRunHistorySessions(sessionIds: readonly string[]): void;
  moveRunHistorySession(sessionId: string, targetTaskId: string): void;
  setSelectedTaskSnapshot: Dispatch<SetStateAction<PlannerTask | null>>;
}) {
  const patchPlannerTask = useCallback((taskId: string, update: (task: PlannerTask) => PlannerTask) => {
    patchLoadedTask(taskId, update);
    setSelectedTaskSnapshot((current) => current?.page.id === taskId
      ? retainEqualValue(current, update(current))
      : current);
  }, [patchLoadedTask, setSelectedTaskSnapshot]);

  const removeSessionsFromPlanner = useCallback((sessionIds: readonly string[]) => {
    removeLoadedSessions(sessionIds);
    removeRunHistorySessions(sessionIds);
    const removed = new Set(sessionIds);
    setSelectedTaskSnapshot((current) => current
      ? removePlannerSessions([current], removed)[0] ?? current
      : current);
  }, [removeLoadedSessions, removeRunHistorySessions, setSelectedTaskSnapshot]);

  const moveSessionInPlanner = useCallback((sessionId: string, targetTaskId: string) => {
    moveLoadedSession(sessionId, targetTaskId);
    moveRunHistorySession(sessionId, targetTaskId);
    setSelectedTaskSnapshot((current) => current
      ? movePlannerSession([current], sessionId, targetTaskId)[0] ?? current
      : current);
  }, [moveLoadedSession, moveRunHistorySession, setSelectedTaskSnapshot]);

  return { patchPlannerTask, removeSessionsFromPlanner, moveSessionInPlanner };
}
