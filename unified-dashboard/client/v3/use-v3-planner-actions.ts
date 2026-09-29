import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { PageApiClient, PageDto } from "@seosoyoung/soul-ui/page";
import { useDashboardStore, type CatalogFolder } from "@seosoyoung/soul-ui";

import { moveBoardItemToFolder } from "../lib/board-workspace-operations";
import { deleteSessions as deleteSessionRecords } from "../lib/delete-session";
import { renameSessionOptimistic } from "../lib/rename-session";
import {
  loadStarredPlannerFolder,
  type PlannerFolder,
  type StarredPlannerFolder,
} from "./planner-data";
import {
  runOptimisticFolderMove,
  type FolderParentTarget,
} from "./folder-parent-move";
import type { FolderMoveTarget } from "./task-move-targets";
import { togglePlannerFolderToday } from "./task-card-actions";
import { setFolderStatus } from "./folder-workspace-api";
import { clearFolderStarChange, publishFolderStarChange } from "./task-star-store";
import { renameFolderPageTitle as renameFolderIdentityTitle } from "./task-workspace-api";
import { runOptimisticTodayMutation } from "./today-task-state";
import { errorText } from "./v3-dashboard-utils";
import { plannerEntryForFolder } from "./folder-workspace-model";

export function useV3PlannerActions({
  api,
  folders,
  notify,
  notifyWriteFailure,
  todayFolderIds,
  setTaskTodayPresence,
  addTaskToToday,
  patchTask,
  removeSessionsFromPlanner,
  moveSessionInPlanner,
  moveTaskProjectInPlanner,
  refreshTask,
}: {
  api: PageApiClient;
  folders: readonly CatalogFolder[];
  notify(message: string): void;
  notifyWriteFailure(action: string, error: unknown): void;
  todayFolderIds: ReadonlySet<string>;
  setTaskTodayPresence(folderId: string, present: boolean): void;
  addTaskToToday(task: PlannerFolder): void;
  patchTask(folderId: string, update: (task: PlannerFolder) => PlannerFolder): void;
  removeSessionsFromPlanner(sessionIds: readonly string[]): void;
  moveSessionInPlanner(sessionId: string, targetFolderId: string): void;
  moveTaskProjectInPlanner(task: PlannerFolder, targetFolderId: string | null): void;
  refreshTask(folderId: string): void;
}) {
  const queryClient = useQueryClient();

  const completeTask = useCallback(async (task: PlannerFolder) => {
    const folderId = task.page.id;
    await runOptimisticTodayMutation({
      folderId,
      wasInToday: todayFolderIds.has(folderId),
      optimisticInToday: false,
      setPresence: setTaskTodayPresence,
      mutate: async () => {
        try {
          const folder = folders.find((candidate) => candidate.id === task.folderId);
          if (!folder?.checklistEnabled) throw new Error("체크리스트가 켜진 폴더만 완료할 수 있습니다.");
          const result = await setFolderStatus(folder, "completed");
          const state = useDashboardStore.getState();
          if (state.catalog) state.setCatalog({
            ...state.catalog,
            folders: state.catalog.folders.map((candidate) => candidate.id === folder.id
              ? result.folder
              : candidate),
          });
          patchTask(folderId, (current) => ({ ...current, status: "completed" }));
          notify(`업무 완료 · ${task.page.title}`);
        } catch (error) {
          notifyWriteFailure("업무 완료", error);
          throw error;
        }
      },
      finalPresence: () => false,
    });
  }, [folders, notify, notifyWriteFailure, patchTask, setTaskTodayPresence, todayFolderIds]);

  const toggleTaskToday = useCallback(async (task: PlannerFolder) => {
    const folderId = task.page.id;
    const wasInToday = todayFolderIds.has(folderId);
    await runOptimisticTodayMutation({
      folderId,
      wasInToday,
      optimisticInToday: !wasInToday,
      setPresence: (changedFolderId, present) => {
        if (present) addTaskToToday(task);
        else setTaskTodayPresence(changedFolderId, false);
      },
      mutate: async () => {
        try {
          const result = await togglePlannerFolderToday(task, api);
          notify(result === "added" ? "오늘 플래너에 추가했습니다" : "오늘 플래너에서 제거했습니다");
          return result;
        } catch (error) {
          notifyWriteFailure("오늘 플래너 변경", error);
          throw error;
        }
      },
      finalPresence: (result) => result === "added",
    });
  }, [addTaskToToday, api, notify, notifyWriteFailure, setTaskTodayPresence, todayFolderIds]);

  const resolveStarredFolder = useCallback(async (task: StarredPlannerFolder) => {
    try {
      if (!("page" in task)) {
        const folder = folders.find((candidate) => candidate.projectPageId === task.id);
        if (folder) return plannerEntryForFolder(folder, task, null);
      }
      return await loadStarredPlannerFolder(api, task, folders);
    } catch (error) {
      notify(`별표 업무 불러오기 실패 · ${errorText(error)}`);
      throw error;
    }
  }, [api, folders, notify]);

  const completeStarredFolder = useCallback(async (task: StarredPlannerFolder) => {
    await completeTask(await resolveStarredFolder(task));
  }, [completeTask, resolveStarredFolder]);

  const toggleStarredFolderToday = useCallback(async (task: StarredPlannerFolder) => {
    await toggleTaskToday(await resolveStarredFolder(task));
  }, [resolveStarredFolder, toggleTaskToday]);

  const renameSession = useCallback(async (sessionId: string, displayName: string | null) => {
    try {
      await renameSessionOptimistic(sessionId, displayName, { queryClient });
      notify("세션 이름을 변경했습니다");
    } catch (error) {
      notifyWriteFailure("세션 이름 변경", error);
      throw error;
    }
  }, [notify, notifyWriteFailure, queryClient]);

  const renameFolderPageTitle = useCallback(async (task: PlannerFolder, title: string) => {
    const mutationId = publishFolderStarChange({
      page: { ...task.page, title },
      starred: task.page.metadata.starred === true,
    });
    try {
      const page = await renameFolderIdentityTitle(api, task.page.id, title);
      patchTask(task.page.id, (current) => ({ ...current, page }));
      notify("업무 제목을 변경했습니다");
      return page.title;
    } catch (error) {
      notifyWriteFailure("업무 제목 변경", error);
      throw error;
    } finally {
      clearFolderStarChange(task.page.id, mutationId);
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

  const moveSession = useCallback(async (sessionId: string, targetTask: FolderMoveTarget) => {
    try {
      await moveBoardItemToFolder({
        boardItemId: `session:${sessionId}`,
        folderId: targetTask.folderId,
        idempotencyKey: `v3-run-move-${crypto.randomUUID()}`,
      });
      moveSessionInPlanner(sessionId, targetTask.page.id);
      notify(`세션 이동 · ${targetTask.page.title}`);
    } catch (error) {
      notifyWriteFailure("세션 이동", error);
      throw error;
    }
  }, [moveSessionInPlanner, notify, notifyWriteFailure]);

  const moveTaskProject = useCallback(async (
    task: PlannerFolder,
    target: FolderParentTarget,
  ) => {
    try {
      const folder = folders.find((candidate) => candidate.id === task.folderId);
      if (!folder) throw new Error("이동할 폴더를 찾을 수 없습니다");
      await runOptimisticFolderMove({
        folder,
        task,
        target,
        project: moveTaskProjectInPlanner,
      });
      notify(`프로젝트 이동 · ${folders.find((candidate) => candidate.id === target.folderId)?.name ?? target.folderId}`);
    } catch (error) {
      refreshTask(task.page.id);
      notifyWriteFailure("프로젝트 이동", error);
      throw error;
    }
  }, [api, folders, moveTaskProjectInPlanner, notify, notifyWriteFailure, refreshTask]);

  return { completeTask, toggleTaskToday, completeStarredFolder, toggleStarredFolderToday, renameFolderPageTitle, renameSession, deleteSessions, moveSession, moveTaskProject };
}
