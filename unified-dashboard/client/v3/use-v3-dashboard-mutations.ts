import { useCallback, type Dispatch, type SetStateAction } from "react";
import { useDashboardStore, type SessionReviewAcknowledgeResult } from "@seosoyoung/soul-ui";
import type { PageApiClient } from "@seosoyoung/soul-ui/page";

import type { PlannerLoadState } from "./PlannerViews";
import type { BrowserPlannerMutationPort } from "./planner-browser-port";
import type { DailyPlannerData, PlannerFolder } from "./planner-data";
import { folderContextCount } from "./planner-model";
import type { RitualAction, RitualQueueItem } from "./ritual-model";
import { saveFolderDescription } from "./folder-workspace-page-api";

export function useV3DashboardMutations({
  api,
  mutationPort,
  daily,
  selectedFolderEntry,
  selectedPageId,
  setAcknowledgedReviewIds,
  notify,
  notifyWriteFailure,
  patchPlannerFolder,
  addFolderToToday,
  refreshDaily,
  refreshFolder,
}: {
  api: PageApiClient;
  mutationPort: BrowserPlannerMutationPort;
  daily: PlannerLoadState<DailyPlannerData>;
  selectedFolderEntry: PlannerFolder | null;
  selectedPageId: string | null;
  setAcknowledgedReviewIds: Dispatch<SetStateAction<ReadonlySet<string>>>;
  notify(message: string): void;
  notifyWriteFailure(action: string, error: unknown): string;
  patchPlannerFolder(folderId: string, update: (task: PlannerFolder) => PlannerFolder): void;
  addFolderToToday(task: PlannerFolder): void;
  refreshDaily(): void;
  refreshFolder(folderId: string): void;
}) {
  const saveMemo = useCallback(async (blockId: string | null, text: string) => {
    if (!daily.data) return;
    try {
      await mutationPort.saveMemo({ pageId: daily.data.daily.page.id, blockId, text });
      refreshDaily();
      notify("오늘 메모 저장됨");
    } catch (error) {
      notifyWriteFailure("오늘 메모 저장", error);
      throw error;
    }
  }, [daily.data, mutationPort, notify, notifyWriteFailure, refreshDaily]);

  const saveDescription = useCallback(async (markdown: string) => {
    if (!selectedFolderEntry) return;
    try {
      await saveFolderDescription(api, selectedFolderEntry.page.id, markdown);
      refreshFolder(selectedFolderEntry.page.id);
      notify("폴더 설명 저장됨");
    } catch (error) {
      notifyWriteFailure("폴더 설명 저장", error);
      throw error;
    }
  }, [api, notify, notifyWriteFailure, refreshFolder, selectedFolderEntry]);

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

  const applyRitualAction = useCallback((item: RitualQueueItem, action: RitualAction) => {
    if (action === "today") addFolderToToday(item.task);
  }, [addFolderToToday]);

  return {
    saveMemo,
    saveDescription,
    acknowledgeReview,
    applyFolderBlocks,
    applyRitualAction,
  };
}
