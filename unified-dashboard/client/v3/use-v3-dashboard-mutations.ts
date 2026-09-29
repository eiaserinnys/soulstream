import { useCallback, type Dispatch, type SetStateAction } from "react";
import { useDashboardStore, type CatalogState, type SessionReviewAcknowledgeResult } from "@seosoyoung/soul-ui";
import type { InitialFolderContext, PageApiClient, PageDto } from "@seosoyoung/soul-ui/page";

import type { PlannerLoadState } from "./PlannerViews";
import type { BrowserPlannerMutationPort } from "./planner-browser-port";
import type { DailyPlannerData, PlannerFolder } from "./planner-data";
import { folderContextCount } from "./planner-model";
import { resolveProjectPage } from "./project-page-actions";
import { createPlannerFolder, plannerFolderCreationErrorLabel } from "./planner-folder-creation";
import type { RitualAction, RitualQueueItem } from "./ritual-model";
import { saveFolderDescription } from "./folder-workspace-page-api";

export function useV3DashboardMutations({
  api,
  mutationPort,
  catalog,
  projects,
  selectedDate,
  today,
  daily,
  selectedProject,
  selectedFolderEntry,
  selectedPageId,
  setCreateOpen,
  setCreatePending,
  clearProject,
  setSelectedDate,
  newDocumentTitle,
  setNewDocumentTitle,
  setNewDocumentOpen,
  setAcknowledgedReviewIds,
  notify,
  notifyWriteFailure,
  patchPlannerFolder,
  addFolderToToday,
  refreshDaily,
  refreshProject,
  refreshFolder,
}: {
  api: PageApiClient;
  mutationPort: BrowserPlannerMutationPort;
  catalog: CatalogState | null;
  projects: readonly PageDto[];
  selectedDate: string;
  today: string;
  daily: PlannerLoadState<DailyPlannerData>;
  selectedProject: PageDto | null;
  selectedFolderEntry: PlannerFolder | null;
  selectedPageId: string | null;
  setCreateOpen: Dispatch<SetStateAction<boolean>>;
  setCreatePending: Dispatch<SetStateAction<boolean>>;
  clearProject(): void;
  setSelectedDate: Dispatch<SetStateAction<string>>;
  newDocumentTitle: string;
  setNewDocumentTitle: Dispatch<SetStateAction<string>>;
  setNewDocumentOpen: Dispatch<SetStateAction<boolean>>;
  setAcknowledgedReviewIds: Dispatch<SetStateAction<ReadonlySet<string>>>;
  notify(message: string): void;
  notifyWriteFailure(action: string, error: unknown): string;
  patchPlannerFolder(folderId: string, update: (task: PlannerFolder) => PlannerFolder): void;
  addFolderToToday(task: PlannerFolder): void;
  refreshDaily(): void;
  refreshProject(): void;
  refreshFolder(folderId: string): void;
}) {
  const createTask = useCallback(async (
    title: string,
    folderId: string,
    description: string,
    initialContext?: InitialFolderContext,
  ): Promise<string | null> => {
    const folder = catalog?.folders.find((item) => item.id === folderId);
    if (!folder) {
      const message = "선택한 프로젝트를 찾을 수 없습니다";
      notify(message);
      return message;
    }
    setCreatePending(true);
    try {
      const projectPage = await resolveProjectPage(api, folder, projects);
      if (!projectPage) {
        const message = "이 폴더는 프로젝트에 연결되지 않아 새 업무를 만들 수 없습니다";
        notify(message);
        return message;
      }
      const dailyPage = selectedDate === today && daily.data
        ? daily.data.daily.page
        : (await api.getDailyPage(today)).page;
      await createPlannerFolder({
        title,
        description,
        dailyPageId: dailyPage.id,
        folderId,
        ...(initialContext ? { initialContext } : {}),
      }, mutationPort);
      setCreateOpen(false);
      clearProject();
      setSelectedDate(today);
      refreshDaily();
      notify(`새 업무 생성 · ${title}`);
      return null;
    } catch (error) {
      return notifyWriteFailure(plannerFolderCreationErrorLabel(error), error);
    } finally {
      setCreatePending(false);
    }
  }, [api, catalog?.folders, clearProject, daily.data, mutationPort, notify, notifyWriteFailure, projects, refreshDaily, selectedDate, setCreateOpen, setCreatePending, setSelectedDate, today]);

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

  const createDocument = useCallback(async () => {
    const title = newDocumentTitle.trim();
    if (!title || !selectedProject) return;
    try {
      await mutationPort.createDocument({ title, sourcePageId: selectedProject.id });
      setNewDocumentTitle("");
      setNewDocumentOpen(false);
      refreshProject();
      notify(`새 문서 생성 · ${title}`);
    } catch (error) {
      notifyWriteFailure("새 문서 생성", error);
    }
  }, [mutationPort, newDocumentTitle, notify, notifyWriteFailure, refreshProject, selectedProject, setNewDocumentOpen, setNewDocumentTitle]);

  const saveDescription = useCallback(async (markdown: string) => {
    if (!selectedFolderEntry) return;
    try {
      await saveFolderDescription(api, selectedFolderEntry.page.id, markdown);
      refreshFolder(selectedFolderEntry.page.id);
      notify("업무 설명 저장됨");
    } catch (error) {
      notifyWriteFailure("업무 설명 저장", error);
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
    createTask,
    saveMemo,
    createDocument,
    saveDescription,
    acknowledgeReview,
    applyFolderBlocks,
    applyRitualAction,
  };
}
