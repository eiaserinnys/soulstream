import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { PageApiClient, PageDto } from "@seosoyoung/soul-ui/page";

import { moveBoardItemToContainer } from "../lib/board-workspace-operations";
import { deleteSessions as deleteSessionRecords } from "../lib/delete-session";
import { renameSessionOptimistic } from "../lib/rename-session";
import { loadStarredPlannerTask, type PlannerTask } from "./planner-data";
import type { TaskMoveTarget } from "./task-move-targets";
import { completePlannerTask, togglePlannerTaskToday } from "./task-card-actions";
import { publishTaskStarChange } from "./task-star-store";
import { renameTaskTitle as renameTaskIdentityTitle } from "./task-workspace-api";
import { runOptimisticTodayMutation } from "./today-task-state";
import { errorText } from "./v3-dashboard-utils";

export function useV3PlannerActions({
  api,
  notify,
  notifyWriteFailure,
  todayTaskIds,
  setTaskTodayPresence,
  addTaskToToday,
  patchTask,
  removeSessionsFromPlanner,
  moveSessionInPlanner,
}: {
  api: PageApiClient;
  notify(message: string): void;
  notifyWriteFailure(action: string, error: unknown): void;
  todayTaskIds: ReadonlySet<string>;
  setTaskTodayPresence(taskId: string, present: boolean): void;
  addTaskToToday(task: PlannerTask): void;
  patchTask(taskId: string, update: (task: PlannerTask) => PlannerTask): void;
  removeSessionsFromPlanner(sessionIds: readonly string[]): void;
  moveSessionInPlanner(sessionId: string, targetTaskId: string): void;
}) {
  const queryClient = useQueryClient();

  const completeTask = useCallback(async (task: PlannerTask) => {
    const taskId = task.page.id;
    await runOptimisticTodayMutation({
      taskId,
      wasInToday: todayTaskIds.has(taskId),
      optimisticInToday: false,
      setPresence: setTaskTodayPresence,
      mutate: async () => {
        try {
          await completePlannerTask(task);
          patchTask(taskId, (current) => ({ ...current, status: "completed" }));
          notify(`업무 완료 · ${task.page.title}`);
        } catch (error) {
          notifyWriteFailure("업무 완료", error);
          throw error;
        }
      },
      finalPresence: () => false,
    });
  }, [notify, notifyWriteFailure, patchTask, setTaskTodayPresence, todayTaskIds]);

  const toggleTaskToday = useCallback(async (task: PlannerTask) => {
    const taskId = task.page.id;
    const wasInToday = todayTaskIds.has(taskId);
    await runOptimisticTodayMutation({
      taskId,
      wasInToday,
      optimisticInToday: !wasInToday,
      setPresence: (changedTaskId, present) => {
        if (present) addTaskToToday(task);
        else setTaskTodayPresence(changedTaskId, false);
      },
      mutate: async () => {
        try {
          const result = await togglePlannerTaskToday(task, api);
          notify(result === "added" ? "오늘 플래너에 추가했습니다" : "오늘 플래너에서 제거했습니다");
          return result;
        } catch (error) {
          notifyWriteFailure("오늘 플래너 변경", error);
          throw error;
        }
      },
      finalPresence: (result) => result === "added",
    });
  }, [addTaskToToday, api, notify, notifyWriteFailure, setTaskTodayPresence, todayTaskIds]);

  const resolveStarredTask = useCallback(async (page: PageDto) => {
    try {
      return await loadStarredPlannerTask(api, page);
    } catch (error) {
      notify(`별표 업무 불러오기 실패 · ${errorText(error)}`);
      throw error;
    }
  }, [api, notify]);

  const completeStarredTask = useCallback(async (page: PageDto) => {
    await completeTask(await resolveStarredTask(page));
  }, [completeTask, resolveStarredTask]);

  const toggleStarredTaskToday = useCallback(async (page: PageDto) => {
    await toggleTaskToday(await resolveStarredTask(page));
  }, [resolveStarredTask, toggleTaskToday]);

  const renameSession = useCallback(async (sessionId: string, displayName: string | null) => {
    try {
      await renameSessionOptimistic(sessionId, displayName, { queryClient });
      notify("세션 이름을 변경했습니다");
    } catch (error) {
      notifyWriteFailure("세션 이름 변경", error);
      throw error;
    }
  }, [notify, notifyWriteFailure, queryClient]);

  const renameTaskTitle = useCallback(async (task: PlannerTask, title: string) => {
    try {
      const page = await renameTaskIdentityTitle(api, task.page.id, title);
      publishTaskStarChange({ page, starred: page.metadata.starred === true });
      patchTask(task.page.id, (current) => ({ ...current, page }));
      notify("업무 제목을 변경했습니다");
      return page.title;
    } catch (error) {
      notifyWriteFailure("업무 제목 변경", error);
      throw error;
    }
  }, [api, notify, notifyWriteFailure, patchTask]);

  const deleteSessions = useCallback(async (sessionIds: string[]) => {
    try {
      await deleteSessionRecords(sessionIds);
      removeSessionsFromPlanner(sessionIds);
      notify("세션을 삭제했습니다");
    } catch (error) {
      notifyWriteFailure("세션 삭제", error);
      throw error;
    }
  }, [notify, notifyWriteFailure, removeSessionsFromPlanner]);

  const moveSession = useCallback(async (sessionId: string, targetTask: TaskMoveTarget) => {
    try {
      await moveBoardItemToContainer({
        boardItemId: `session:${sessionId}`,
        container: { kind: "runbook", id: targetTask.runbookId },
        idempotencyKey: `v3-run-move-${crypto.randomUUID()}`,
      });
      moveSessionInPlanner(sessionId, targetTask.page.id);
      notify(`세션 이동 · ${targetTask.page.title}`);
    } catch (error) {
      notifyWriteFailure("세션 이동", error);
      throw error;
    }
  }, [moveSessionInPlanner, notify, notifyWriteFailure]);

  return { completeTask, toggleTaskToday, completeStarredTask, toggleStarredTaskToday, renameTaskTitle, renameSession, deleteSessions, moveSession };
}
