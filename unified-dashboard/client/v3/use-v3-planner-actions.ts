import { useCallback, type Dispatch, type SetStateAction } from "react";
import type { PageApiClient } from "@seosoyoung/soul-ui/page";

import { moveBoardItemToContainer } from "../lib/board-workspace-operations";
import { deleteSessions as deleteSessionRecords } from "../lib/delete-session";
import { renameSessionOptimistic } from "../lib/rename-session";
import type { PlannerTask } from "./planner-data";
import { completePlannerTask, togglePlannerTaskToday } from "./task-card-actions";
import { unmountTaskDocument } from "./task-workspace-api";
import { errorText } from "./v3-dashboard-utils";

export function useV3PlannerActions({
  api,
  setRefreshKey,
  notify,
}: {
  api: PageApiClient;
  setRefreshKey: Dispatch<SetStateAction<number>>;
  notify(message: string): void;
}) {
  const refresh = useCallback(() => setRefreshKey((value) => value + 1), [setRefreshKey]);

  const completeTask = useCallback(async (task: PlannerTask) => {
    try {
      await completePlannerTask(task);
      refresh();
      notify(`업무 완료 · ${task.page.title}`);
    } catch (error) {
      notify(`업무 완료 실패 · ${errorText(error)}`);
      throw error;
    }
  }, [notify, refresh]);

  const toggleTaskToday = useCallback(async (task: PlannerTask) => {
    try {
      const result = await togglePlannerTaskToday(task, api);
      refresh();
      notify(result === "added" ? "오늘 플래너에 추가했습니다" : "오늘 플래너에서 제거했습니다");
    } catch (error) {
      notify(`오늘 플래너 변경 실패 · ${errorText(error)}`);
      throw error;
    }
  }, [api, notify, refresh]);

  const renameSession = useCallback(async (sessionId: string, displayName: string | null) => {
    await renameSessionOptimistic(sessionId, displayName);
    refresh();
    notify("세션 이름을 변경했습니다");
  }, [notify, refresh]);

  const deleteSessions = useCallback(async (sessionIds: string[]) => {
    try {
      await deleteSessionRecords(sessionIds);
      refresh();
      notify("세션을 삭제했습니다");
    } catch (error) {
      notify(`세션 삭제 실패 · ${errorText(error)}`);
      throw error;
    }
  }, [notify, refresh]);

  const moveSession = useCallback(async (sessionId: string, targetTask: PlannerTask) => {
    try {
      await moveBoardItemToContainer({
        boardItemId: `session:${sessionId}`,
        container: { kind: "runbook", id: targetTask.runbookId },
        idempotencyKey: `v3-run-move-${crypto.randomUUID()}`,
      });
      refresh();
      notify(`run 이동 · ${targetTask.page.title}`);
    } catch (error) {
      notify(`run 이동 실패 · ${errorText(error)}`);
      throw error;
    }
  }, [notify, refresh]);

  const unmountDocument = useCallback(async (task: PlannerTask, blockId: string) => {
    try {
      await unmountTaskDocument(api, task.page.id, blockId);
      refresh();
      notify("문서 마운트를 해제했습니다");
    } catch (error) {
      notify(`문서 마운트 해제 실패 · ${errorText(error)}`);
      throw error;
    }
  }, [api, notify, refresh]);

  return { completeTask, toggleTaskToday, renameSession, deleteSessions, moveSession, unmountDocument };
}
