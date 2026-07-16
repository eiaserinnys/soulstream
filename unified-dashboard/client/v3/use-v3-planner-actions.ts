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
import { renameTaskTitle as renameTaskIdentityTitle, unmountTaskDocument } from "./task-workspace-api";
import { runOptimisticTodayMutation } from "./today-task-state";
import { errorText } from "./v3-dashboard-utils";

export function useV3PlannerActions({
  api,
  invalidate,
  notify,
  notifyWriteFailure,
  todayTaskIds,
  setTaskTodayPresence,
}: {
  api: PageApiClient;
  invalidate(): void;
  notify(message: string): void;
  notifyWriteFailure(action: string, error: unknown): void;
  todayTaskIds: ReadonlySet<string>;
  setTaskTodayPresence(taskId: string, present: boolean): void;
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
          invalidate();
          notify(`업무 완료 · ${task.page.title}`);
        } catch (error) {
          notifyWriteFailure("업무 완료", error);
          throw error;
        }
      },
      finalPresence: () => false,
    });
  }, [invalidate, notify, notifyWriteFailure, setTaskTodayPresence, todayTaskIds]);

  const toggleTaskToday = useCallback(async (task: PlannerTask) => {
    const taskId = task.page.id;
    const wasInToday = todayTaskIds.has(taskId);
    await runOptimisticTodayMutation({
      taskId,
      wasInToday,
      optimisticInToday: !wasInToday,
      setPresence: setTaskTodayPresence,
      mutate: async () => {
        try {
          const result = await togglePlannerTaskToday(task, api);
          invalidate();
          notify(result === "added" ? "오늘 플래너에 추가했습니다" : "오늘 플래너에서 제거했습니다");
          return result;
        } catch (error) {
          notifyWriteFailure("오늘 플래너 변경", error);
          throw error;
        }
      },
      finalPresence: (result) => result === "added",
    });
  }, [api, invalidate, notify, notifyWriteFailure, setTaskTodayPresence, todayTaskIds]);

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
      invalidate();
      notify("세션 이름을 변경했습니다");
    } catch (error) {
      notifyWriteFailure("세션 이름 변경", error);
      throw error;
    }
  }, [invalidate, notify, notifyWriteFailure, queryClient]);

  const renameTaskTitle = useCallback(async (task: PlannerTask, title: string) => {
    try {
      const page = await renameTaskIdentityTitle(api, task.page.id, title);
      publishTaskStarChange({ page, starred: page.metadata.starred === true });
      invalidate();
      notify("업무 제목을 변경했습니다");
      return page.title;
    } catch (error) {
      notifyWriteFailure("업무 제목 변경", error);
      throw error;
    }
  }, [api, invalidate, notify, notifyWriteFailure]);

  const deleteSessions = useCallback(async (sessionIds: string[]) => {
    try {
      await deleteSessionRecords(sessionIds);
      invalidate();
      notify("세션을 삭제했습니다");
    } catch (error) {
      notifyWriteFailure("세션 삭제", error);
      throw error;
    }
  }, [invalidate, notify, notifyWriteFailure]);

  const moveSession = useCallback(async (sessionId: string, targetTask: TaskMoveTarget) => {
    try {
      await moveBoardItemToContainer({
        boardItemId: `session:${sessionId}`,
        container: { kind: "runbook", id: targetTask.runbookId },
        idempotencyKey: `v3-run-move-${crypto.randomUUID()}`,
      });
      invalidate();
      notify(`세션 이동 · ${targetTask.page.title}`);
    } catch (error) {
      notifyWriteFailure("세션 이동", error);
      throw error;
    }
  }, [invalidate, notify, notifyWriteFailure]);

  const unmountDocument = useCallback(async (task: PlannerTask, blockId: string) => {
    try {
      await unmountTaskDocument(api, task.page.id, blockId);
      invalidate();
      notify("문서 마운트를 해제했습니다");
    } catch (error) {
      notifyWriteFailure("문서 마운트 해제", error);
      throw error;
    }
  }, [api, invalidate, notify, notifyWriteFailure]);

  return { completeTask, toggleTaskToday, completeStarredTask, toggleStarredTaskToday, renameTaskTitle, renameSession, deleteSessions, moveSession, unmountDocument };
}
