import { useTranslation } from "react-i18next";
import { useCallback, type Dispatch, type SetStateAction } from "react";
import { useDashboardStore, type SessionReviewAcknowledgeResult } from "@seosoyoung/soul-ui";
import type { PageApiClient } from "@seosoyoung/soul-ui/page";

import type { PlannerFolder } from "./planner-data";
import { folderContextCount } from "./planner-model";
import { saveFolderDescription } from "./folder-workspace-page-api";

export function useV3DashboardMutations({
  api,
  selectedFolderEntry,
  selectedPageId,
  setAcknowledgedReviewIds,
  notify,
  notifyWriteFailure,
  patchPlannerFolder,
  refreshFolder,
}: {
  api: PageApiClient;
  selectedFolderEntry: PlannerFolder | null;
  selectedPageId: string | null;
  setAcknowledgedReviewIds: Dispatch<SetStateAction<ReadonlySet<string>>>;
  notify(message: string): void;
  notifyWriteFailure(action: string, error: unknown): string;
  patchPlannerFolder(folderId: string, update: (task: PlannerFolder) => PlannerFolder): void;
  refreshFolder(folderId: string): void;
}) {
  const { t } = useTranslation();
  const saveDescription = useCallback(async (markdown: string) => {
    if (!selectedFolderEntry) return;
    try {
      await saveFolderDescription(api, selectedFolderEntry.page.id, markdown);
      refreshFolder(selectedFolderEntry.page.id);
      notify(t("sessions.folderDescriptionSaved"));
    } catch (error) {
      notifyWriteFailure(t("sessions.saveFolderDescription"), error);
      throw error;
    }
  }, [t, api, notify, notifyWriteFailure, refreshFolder, selectedFolderEntry]);

  const acknowledgeReview = useCallback((result: SessionReviewAcknowledgeResult) => {
    setAcknowledgedReviewIds((current) => new Set([...current, result.agentSessionId]));
    const state = useDashboardStore.getState();
    const current = state.activeSessionSummary;
    if (current?.agentSessionId === result.agentSessionId) {
      state.setActiveSessionSummary({ ...current, reviewState: result.reviewState });
    }
  }, [setAcknowledgedReviewIds]);

  const applyFolderBlocks = useCallback((blocks: PlannerFolder["blocks"]) => {
    if (!selectedPageId) return;
    patchPlannerFolder(selectedPageId, (current) => ({
      ...current,
      blocks,
      contextCount: folderContextCount(blocks),
    }));
  }, [patchPlannerFolder, selectedPageId]);

  return {
    saveDescription,
    acknowledgeReview,
    applyFolderBlocks,
  };
}
