import { folderErrorText } from "./folder-messages";
import { useTranslation } from "react-i18next";
import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { PageApiClient } from "@seosoyoung/soul-ui/page";
import { useDashboardStore, type CatalogFolder } from "@seosoyoung/soul-ui";

import { moveSessionTree } from "../lib/move-sessions";
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
import type { FolderMoveTarget } from "./folder-move-targets";
import { setFolderStatus } from "./folder-workspace-api";
import { clearFolderStarChange, publishFolderStarChange } from "./folder-star-store";
import { renameFolderPageTitle as renameFolderIdentityTitle } from "./folder-workspace-page-api";
import { plannerEntryForFolder } from "./folder-workspace-model";

export function useV3PlannerActions({
  api,
  folders,
  notify,
  notifyWriteFailure,
  patchFolder,
  removeSessionsFromPlanner,
  moveSessionInPlanner,
  moveFolderParentInPlanner,
  refreshFolder,
}: {
  api: PageApiClient;
  folders: readonly CatalogFolder[];
  notify(message: string): void;
  notifyWriteFailure(action: string, error: unknown): void;
  patchFolder(folderId: string, update: (task: PlannerFolder) => PlannerFolder): void;
  removeSessionsFromPlanner(sessionIds: readonly string[]): void;
  moveSessionInPlanner(sessionId: string, targetFolderId: string): void;
  moveFolderParentInPlanner(task: PlannerFolder, targetFolderId: string | null): void;
  refreshFolder(folderId: string): void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const completeFolder = useCallback(async (task: PlannerFolder) => {
    const folderId = task.page.id;
    try {
      const folder = folders.find((candidate) => candidate.id === task.folderId);
      if (!folder) throw new Error(t("folders.errors.noFolder"));
      const result = await setFolderStatus(folder, "completed");
      const state = useDashboardStore.getState();
      if (state.catalog) state.setCatalog({
        ...state.catalog,
        folders: state.catalog.folders.map((candidate) => candidate.id === folder.id ? result.folder : candidate),
      });
      patchFolder(folderId, (current) => ({ ...current, status: "completed" }));
      notify(t("folders.planner.folderCompleted", { name: task.page.title }));
    } catch (error) {
      notifyWriteFailure(t("folders.planner.completeFolder"), error);
      throw error;
    }
  }, [t, folders, notify, notifyWriteFailure, patchFolder]);

  const resolveStarredFolder = useCallback(async (task: StarredPlannerFolder) => {
    try {
      if (!("page" in task)) {
        const folder = folders.find((candidate) => candidate.projectPageId === task.id);
        if (folder) return plannerEntryForFolder(folder, task, null);
      }
      return await loadStarredPlannerFolder(api, task, folders);
    } catch (error) {
      notify(t("folders.errors.starredRead", { detail: folderErrorText(t, error) }));
      throw error;
    }
  }, [t, api, folders, notify]);

  const completeStarredFolder = useCallback(async (task: StarredPlannerFolder) => {
    await completeFolder(await resolveStarredFolder(task));
  }, [completeFolder, resolveStarredFolder]);

  const renameSession = useCallback(async (sessionId: string, displayName: string | null) => {
    try {
      await renameSessionOptimistic(sessionId, displayName, { queryClient });
      notify(t("folders.planner.sessionRenamed"));
    } catch (error) {
      notifyWriteFailure(t("folders.planner.renameSession"), error);
      throw error;
    }
  }, [t, notify, notifyWriteFailure, queryClient]);

  const renameFolderPageTitle = useCallback(async (task: PlannerFolder, title: string) => {
    const mutationId = publishFolderStarChange({
      page: { ...task.page, title },
      starred: task.page.metadata.starred === true,
    });
    try {
      const page = await renameFolderIdentityTitle(api, task.page.id, title);
      patchFolder(task.page.id, (current) => ({ ...current, page }));
      notify(t("folders.planner.folderRenamed"));
      return page.title;
    } catch (error) {
      notifyWriteFailure(t("folders.planner.renameFolder"), error);
      throw error;
    } finally {
      clearFolderStarChange(task.page.id, mutationId);
    }
  }, [t, api, notify, notifyWriteFailure, patchFolder]);

  const deleteSessions = useCallback(async (sessionIds: string[]) => {
    try {
      await deleteSessionRecords(sessionIds);
      removeSessionsFromPlanner(sessionIds);
      notify(t("folders.planner.sessionDeleted"));
    } catch (error) {
      notifyWriteFailure(t("folders.planner.deleteSession"), error);
      throw error;
    }
  }, [t, notify, notifyWriteFailure, removeSessionsFromPlanner]);

  const moveSession = useCallback(async (sessionId: string, targetFolder: FolderMoveTarget) => {
    try {
      const sessionIds = await moveSessionTree(sessionId,targetFolder.folderId);
      useDashboardStore.getState().moveSessionsToFolder(sessionIds,targetFolder.folderId);
      for (const id of sessionIds) moveSessionInPlanner(id, targetFolder.page.id);
      notify(t("folders.planner.sessionMoved", { name: targetFolder.page.title }));
    } catch (error) {
      notifyWriteFailure(t("folders.planner.moveSession"), error);
      throw error;
    }
  }, [t, moveSessionInPlanner, notify, notifyWriteFailure]);

  const moveFolderParent = useCallback(async (
    task: PlannerFolder,
    target: FolderParentTarget,
  ) => {
    try {
      const folder = folders.find((candidate) => candidate.id === task.folderId);
      if (!folder) throw new Error(t("folders.errors.noMoveFolder"));
      await runOptimisticFolderMove({
        folder,
        task,
        target,
        project: moveFolderParentInPlanner,
      });
      notify(t("folders.planner.folderMoved", { name: folders.find((candidate) => candidate.id === target.folderId)?.name ?? target.folderId }));
    } catch (error) {
      refreshFolder(task.page.id);
      notifyWriteFailure(t("folders.move.title"), error);
      throw error;
    }
  }, [t, api, folders, moveFolderParentInPlanner, notify, notifyWriteFailure, refreshFolder]);

  return { completeFolder, completeStarredFolder, renameFolderPageTitle, renameSession, deleteSessions, moveSession, moveFolderParent };
}
