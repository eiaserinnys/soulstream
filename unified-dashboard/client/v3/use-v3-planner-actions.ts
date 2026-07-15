import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { PageApiClient } from "@seosoyoung/soul-ui/page";

import { moveBoardItemToContainer } from "../lib/board-workspace-operations";
import { deleteSessions as deleteSessionRecords } from "../lib/delete-session";
import { renameSessionOptimistic } from "../lib/rename-session";
import type { PlannerTask } from "./planner-data";
import type { TaskMoveTarget } from "./task-move-targets";
import { completePlannerTask, togglePlannerTaskToday } from "./task-card-actions";
import { publishTaskStarChange } from "./task-star-store";
import { renameTaskTitle as renameTaskIdentityTitle, unmountTaskDocument } from "./task-workspace-api";
import { errorText } from "./v3-dashboard-utils";

export function useV3PlannerActions({
  api,
  invalidate,
  notify,
}: {
  api: PageApiClient;
  invalidate(): void;
  notify(message: string): void;
}) {
  const queryClient = useQueryClient();

  const completeTask = useCallback(async (task: PlannerTask) => {
    try {
      await completePlannerTask(task);
      invalidate();
      notify(`업무 완료 · ${task.page.title}`);
    } catch (error) {
      notify(`업무 완료 실패 · ${errorText(error)}`);
      throw error;
    }
  }, [invalidate, notify]);

  const toggleTaskToday = useCallback(async (task: PlannerTask) => {
    try {
      const result = await togglePlannerTaskToday(task, api);
      invalidate();
      notify(result === "added" ? "오늘 플래너에 추가했습니다" : "오늘 플래너에서 제거했습니다");
      return result;
    } catch (error) {
      notify(`오늘 플래너 변경 실패 · ${errorText(error)}`);
      throw error;
    }
  }, [api, invalidate, notify]);

  const renameSession = useCallback(async (sessionId: string, displayName: string | null) => {
    try {
      await renameSessionOptimistic(sessionId, displayName, { queryClient });
      invalidate();
      notify("세션 이름을 변경했습니다");
    } catch (error) {
      notify(`세션 이름 변경 실패 · ${errorText(error)}`);
      throw error;
    }
  }, [invalidate, notify, queryClient]);

  const renameTaskTitle = useCallback(async (task: PlannerTask, title: string) => {
    try {
      const page = await renameTaskIdentityTitle(api, task.page.id, title);
      publishTaskStarChange({ page, starred: page.metadata.starred === true });
      invalidate();
      notify("업무 제목을 변경했습니다");
      return page.title;
    } catch (error) {
      notify(`업무 제목 변경 실패 · ${errorText(error)}`);
      throw error;
    }
  }, [api, invalidate, notify]);

  const deleteSessions = useCallback(async (sessionIds: string[]) => {
    try {
      await deleteSessionRecords(sessionIds);
      invalidate();
      notify("세션을 삭제했습니다");
    } catch (error) {
      notify(`세션 삭제 실패 · ${errorText(error)}`);
      throw error;
    }
  }, [invalidate, notify]);

  const moveSession = useCallback(async (sessionId: string, targetTask: TaskMoveTarget) => {
    try {
      await moveBoardItemToContainer({
        boardItemId: `session:${sessionId}`,
        container: { kind: "runbook", id: targetTask.runbookId },
        idempotencyKey: `v3-run-move-${crypto.randomUUID()}`,
      });
      invalidate();
      notify(`run 이동 · ${targetTask.page.title}`);
    } catch (error) {
      notify(`run 이동 실패 · ${errorText(error)}`);
      throw error;
    }
  }, [invalidate, notify]);

  const unmountDocument = useCallback(async (task: PlannerTask, blockId: string) => {
    try {
      await unmountTaskDocument(api, task.page.id, blockId);
      invalidate();
      notify("문서 마운트를 해제했습니다");
    } catch (error) {
      notify(`문서 마운트 해제 실패 · ${errorText(error)}`);
      throw error;
    }
  }, [api, invalidate, notify]);

  return { completeTask, toggleTaskToday, renameTaskTitle, renameSession, deleteSessions, moveSession, unmountDocument };
}
