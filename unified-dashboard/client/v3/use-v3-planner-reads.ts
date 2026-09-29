import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { retainEqualSet, retainEqualValue } from "@seosoyoung/soul-ui";
import type { PageApiClient, PageDto } from "@seosoyoung/soul-ui/page";

import type { PlannerLoadState } from "./PlannerViews";
import {
  beginPlannerLoad,
  completePlannerLoad,
  failPlannerLoad,
  loadConfirmedResult,
} from "./planner-query-state";
import type { FolderStarChange } from "./task-star-store";
import {
  loadDailyPlanner,
  loadProjectDocumentPage,
  loadFolderSubfolderPage,
  loadStarredFolders,
  loadProjectPlanner,
  starredFolderPage,
  type DailyPlannerData,
  type PlannerDataDependencies,
  type PlannerPage,
  type PlannerFolder,
  type ProjectPlannerData,
  type StarredPlannerFolder,
} from "./planner-data";
import {
  applyStarredPlannerFolderChanges,
  isStarredPlannerPageCurrent,
  mergeStarredPlannerFolders,
} from "./starred-planner-collection";
import {
  isStarredFolderRefreshCurrent,
  isStarredFolderRequestCurrent,
  isStarredFolderSnapshotCurrent,
} from "./starred-task-order";
import {
  movePlannerSession,
  removePlannerSessions,
  replacePlannerFolder,
} from "./planner-mutation-projection";
import { usePlannerProjectMoveProjection } from "./use-planner-project-move-projection";
import { useStarredFolderReorder } from "./use-starred-task-reorder";
import { useV3PageInvalidationKey } from "./v3-live-invalidation-plane";


export function usePlannerCollections({
  api,
  dependencies,
  selectedDate,
  today,
  selectedProject,
  selectedFolderId,
  folderStarChanges,
  refreshKeys,
  notify,
}: {
  api: PageApiClient;
  dependencies: PlannerDataDependencies;
  selectedDate: string;
  today: string;
  selectedProject: PageDto | null;
  selectedFolderId: string | null;
  folderStarChanges: readonly FolderStarChange[];
  refreshKeys: {
    daily: number;
    project: number;
    starred: number;
  };
  notify(message: string): void;
}) {
  const [daily, setDaily] = useState<PlannerLoadState<DailyPlannerData>>({ status: "loading", data: null, message: null });
  const [todayFolderIds, setTodayFolderIds] = useState<ReadonlySet<string>>(() => new Set());
  const [project, setProject] = useState<PlannerLoadState<ProjectPlannerData>>({ status: "loading", data: null, message: null });
  const [starredFolderIndex, setStarredFolderIndex] = useState<PlannerLoadState<PlannerPage<StarredPlannerFolder>>>({ status: "loading", data: null, message: null });
  const [starredLoadedRefreshKey, setStarredLoadedRefreshKey] = useState<number | null>(null);
  const [starredFoldersLoadingMore, setStarredFoldersLoadingMore] = useState(false);
  const [projectDocumentsLoadingMore, setProjectDocumentsLoadingMore] = useState(false);
  const [subfoldersLoadingMore, setSubfoldersLoadingMore] = useState(false);
  const [mutationRefresh, setMutationRefresh] = useState({ daily: 0, project: 0 });
  const dailyRef = useRef(daily);
  const projectRef = useRef(project);
  const starredFolderIndexRef = useRef(starredFolderIndex);
  const starredRefreshKeyRef = useRef(refreshKeys.starred);
  const starredLoadedRefreshKeyRef = useRef<number | null>(null);
  const starredOrderRevisionRef = useRef(0);
  const stableProjectsRef = useRef<PageDto[]>([]);
  const stableStarredFoldersRef = useRef<StarredPlannerFolder[]>([]);
  dailyRef.current = daily;
  projectRef.current = project;
  starredFolderIndexRef.current = starredFolderIndex;
  starredRefreshKeyRef.current = refreshKeys.starred;

  const dailyPageRefreshKey = useV3PageInvalidationKey([
    daily.data?.daily.page.id,
    ...(daily.data?.tasks.map((task) => task.page.id) ?? []),
  ]);
  const projectPageRefreshKey = useV3PageInvalidationKey([
    selectedProject?.id,
    project.data?.project.id,
    ...(project.data?.tasks.map((task) => task.page.id) ?? []),
    ...(project.data?.documents.map((document) => document.id) ?? []),
  ]);

  useEffect(() => {
    let active = true;
    const refreshKey = refreshKeys.starred;
    const orderRevision = starredOrderRevisionRef.current;
    const hadCurrentSnapshot = isStarredFolderSnapshotCurrent({
      loadedRefreshKey: starredLoadedRefreshKeyRef.current,
      expectedRefreshKey: refreshKey,
      currentRefreshKey: starredRefreshKeyRef.current,
      expectedOrderRevision: orderRevision,
      currentOrderRevision: starredOrderRevisionRef.current,
    });
    starredLoadedRefreshKeyRef.current = null;
    setStarredLoadedRefreshKey(null);
    const previous = starredFolderIndexRef.current.data;
    setStarredFolderIndex(beginPlannerLoad);
    void loadConfirmedResult({
      previous,
      load: () => loadStarredFolders(dependencies, {}),
      clearsVisibleContent: (current, next) => current.items.length > 0 && next.items.length === 0,
    }).then((data) => {
      if (active && isStarredFolderRequestCurrent({
        expectedRefreshKey: refreshKey,
        currentRefreshKey: starredRefreshKeyRef.current,
        expectedOrderRevision: orderRevision,
        currentOrderRevision: starredOrderRevisionRef.current,
      })) {
        starredLoadedRefreshKeyRef.current = refreshKey;
        setStarredLoadedRefreshKey(refreshKey);
        setStarredFolderIndex((current) => isStarredFolderRequestCurrent({
          expectedRefreshKey: refreshKey,
          currentRefreshKey: starredRefreshKeyRef.current,
          expectedOrderRevision: orderRevision,
          currentOrderRevision: starredOrderRevisionRef.current,
        }) ? completePlannerLoad(current, data) : current);
      }
    }).catch((error: unknown) => {
      if (active && isStarredFolderRequestCurrent({
        expectedRefreshKey: refreshKey,
        currentRefreshKey: starredRefreshKeyRef.current,
        expectedOrderRevision: orderRevision,
        currentOrderRevision: starredOrderRevisionRef.current,
      })) {
        if (hadCurrentSnapshot || isStarredFolderSnapshotCurrent({
          loadedRefreshKey: starredLoadedRefreshKeyRef.current,
          expectedRefreshKey: refreshKey,
          currentRefreshKey: starredRefreshKeyRef.current,
          expectedOrderRevision: orderRevision,
          currentOrderRevision: starredOrderRevisionRef.current,
        })) {
          starredLoadedRefreshKeyRef.current = refreshKey;
          setStarredLoadedRefreshKey(refreshKey);
          setStarredFolderIndex((current) => current.data
            ? completePlannerLoad(current, current.data)
            : current);
          return;
        }
        starredLoadedRefreshKeyRef.current = null;
        setStarredLoadedRefreshKey(null);
        const message = errorText(error);
        setStarredFolderIndex((current) => {
          const failed = failPlannerLoad(current, message);
          return failed.data
            ? { ...failed, data: { ...failed.data, nextCursor: null } }
            : failed;
        });
        notify(`별표 업무 조회 실패 · ${message}`);
      }
    });
    return () => { active = false; };
  }, [dependencies, notify, refreshKeys.starred]);

  useEffect(() => {
    let active = true;
    const previous = dailyRef.current.data;
    setDaily(beginPlannerLoad);
    void loadConfirmedResult({
      previous,
      load: () => loadDailyPlanner(api, selectedDate, dependencies),
      clearsVisibleContent: (current, next) => current.tasks.length > 0 && next.tasks.length === 0,
    }).then((data) => {
      if (active) {
        setDaily((current) => completePlannerLoad(current, data));
        if (selectedDate === today) {
          setTodayFolderIds((current) => retainEqualSet(current, new Set(data.tasks.map((task) => task.page.id))));
        }
      }
    }).catch((error: unknown) => {
      if (active) setDaily((current) => failPlannerLoad(current, errorText(error)));
    });
    return () => { active = false; };
  }, [api, dailyPageRefreshKey, dependencies, mutationRefresh.daily, refreshKeys.daily, selectedDate, today]);

  useEffect(() => {
    if (selectedDate === today) return;
    let active = true;
    void loadDailyPlanner(api, today, dependencies).then((data) => {
      if (active) {
        setTodayFolderIds((current) => retainEqualSet(current, new Set(data.tasks.map((task) => task.page.id))));
      }
    }).catch(() => {
      // The selected planner remains usable; its own error surface handles load failures.
    });
    return () => { active = false; };
  }, [api, dailyPageRefreshKey, dependencies, mutationRefresh.daily, refreshKeys.daily, selectedDate, today]);

  const setTaskTodayPresence = useCallback((folderId: string, present: boolean) => {
    setTodayFolderIds((current) => {
      const next = new Set(current);
      if (present) next.add(folderId);
      else next.delete(folderId);
      return retainEqualSet(current, next);
    });
  }, []);

  const addTaskToToday = useCallback((task: PlannerFolder) => {
    setTaskTodayPresence(task.page.id, true);
    if (selectedDate !== today) return;
    setDaily((current) => {
      if (!current.data || current.data.tasks.some((candidate) => candidate.page.id === task.page.id)) return current;
      return retainEqualValue(current, {
        ...current,
        data: { ...current.data, tasks: [...current.data.tasks, task] },
      });
    });
  }, [selectedDate, setTaskTodayPresence, today]);

  const projects = useMemo(() => {
    const next = mergePages(daily.data?.projects ?? [], selectedProject ? [selectedProject] : []);
    stableProjectsRef.current = retainEqualValue(stableProjectsRef.current, next);
    return stableProjectsRef.current;
  }, [daily.data?.projects, selectedProject]);
  const starredFolders = useMemo(() => {
    const next = applyStarredPlannerFolderChanges(starredFolderIndex.data?.items ?? [], folderStarChanges);
    stableStarredFoldersRef.current = retainEqualValue(stableStarredFoldersRef.current, next);
    return stableStarredFoldersRef.current;
  }, [starredFolderIndex.data?.items, folderStarChanges]);

  useEffect(() => {
    if (!selectedProject || !selectedFolderId) return;
    let active = true;
    setProjectDocumentsLoadingMore(false);
    setSubfoldersLoadingMore(false);
    const previous = projectRef.current.data?.project.id === selectedProject.id
      ? projectRef.current.data
      : null;
    setProject((current) => current.data?.project.id === selectedProject.id
      ? beginPlannerLoad(current)
      : { status: "loading", data: null, message: null });
    void loadConfirmedResult({
      previous,
      load: () => loadProjectPlanner(api, selectedFolderId, selectedProject, dependencies),
      clearsVisibleContent: (current, next) => (
        current.tasks.length + current.documents.length > 0
        && next.tasks.length + next.documents.length === 0
      ),
    }).then((data) => {
      if (active) setProject((current) => completePlannerLoad(current, data));
    }).catch((error: unknown) => {
      if (active) setProject((current) => failPlannerLoad(current, errorText(error)));
    });
    return () => { active = false; };
  }, [api, dependencies, mutationRefresh.project, projectPageRefreshKey, refreshKeys.project, selectedFolderId, selectedProject]);

  const updateLoadedTasks = useCallback((update: (tasks: PlannerFolder[]) => PlannerFolder[]) => {
    setDaily((current) => {
      if (!current.data) return current;
      const tasks = update(current.data.tasks);
      return tasks === current.data.tasks
        ? current
        : retainEqualValue(current, { ...current, data: { ...current.data, tasks } });
    });
    setProject((current) => {
      if (!current.data) return current;
      const tasks = update(current.data.tasks);
      return tasks === current.data.tasks
        ? current
        : retainEqualValue(current, { ...current, data: { ...current.data, tasks } });
    });
  }, []);

  const patchTask = useCallback((folderId: string, update: (task: PlannerFolder) => PlannerFolder) => {
    updateLoadedTasks((tasks) => replacePlannerFolder(tasks, folderId, update));
  }, [updateLoadedTasks]);

  const removeSessions = useCallback((sessionIds: readonly string[]) => {
    const removedIds = new Set(sessionIds);
    updateLoadedTasks((tasks) => removePlannerSessions(tasks, removedIds));
  }, [updateLoadedTasks]);

  const moveSession = useCallback((sessionId: string, targetFolderId: string) => {
    updateLoadedTasks((tasks) => movePlannerSession(tasks, sessionId, targetFolderId));
  }, [updateLoadedTasks]);

  const moveTaskProject = usePlannerProjectMoveProjection(setDaily, setProject);
  const { starredFoldersReordering, reorderStarredFolders } = useStarredFolderReorder({
    dependencies,
    notify,
    starredFolderIndexRef,
    starredLoadedRefreshKeyRef,
    starredOrderRevisionRef,
    setStarredLoadedRefreshKey,
    starredRefreshKeyRef,
    stableStarredFoldersRef,
    setStarredFolderIndex,
  });

  const refreshDaily = useCallback(() => {
    setMutationRefresh((current) => ({ ...current, daily: current.daily + 1 }));
  }, []);

  const refreshProject = useCallback(() => {
    setMutationRefresh((current) => ({ ...current, project: current.project + 1 }));
  }, []);

  const refreshTask = useCallback((folderId: string) => {
    const inDaily = dailyRef.current.data?.tasks.some((task) => task.page.id === folderId) ?? false;
    const inProject = selectedProject?.id === folderId;
    if (!inDaily && !inProject) return;
    setMutationRefresh((current) => ({
      daily: inDaily ? current.daily + 1 : current.daily,
      project: inProject ? current.project + 1 : current.project,
    }));
  }, [selectedProject?.id]);

  const loadMoreStarredFolders = useCallback(async () => {
    const page = starredFolderIndex.data;
    const cursor = page?.nextCursor;
    if (
      !page
      || !cursor
      || starredFoldersLoadingMore
      || !isStarredFolderRefreshCurrent(starredLoadedRefreshKeyRef.current, starredRefreshKeyRef.current)
    ) return;
    const expectedPageIds = page.items.map((task) => starredFolderPage(task).id);
    const refreshKey = starredRefreshKeyRef.current;
    const orderRevision = starredOrderRevisionRef.current;
    setStarredFoldersLoadingMore(true);
    try {
      const next = await loadStarredFolders(dependencies, { cursor });
      if (!isStarredFolderRequestCurrent({
        expectedRefreshKey: refreshKey,
        currentRefreshKey: starredRefreshKeyRef.current,
        expectedOrderRevision: orderRevision,
        currentOrderRevision: starredOrderRevisionRef.current,
      })) return;
      setStarredFolderIndex((current) => {
        if (!isStarredFolderRequestCurrent({
          expectedRefreshKey: refreshKey,
          currentRefreshKey: starredRefreshKeyRef.current,
          expectedOrderRevision: orderRevision,
          currentOrderRevision: starredOrderRevisionRef.current,
        })) return current;
        const currentPage = current.data;
        if (!isStarredPlannerPageCurrent(currentPage, expectedPageIds, cursor) || !currentPage) {
          return current;
        }
        return completePlannerLoad(current, {
          items: mergeStarredPlannerFolders(currentPage.items, next.items),
          nextCursor: next.nextCursor,
        });
      });
    } catch (error) {
      notify(`별표 업무 더 보기 실패 · ${errorText(error)}`);
    } finally {
      setStarredFoldersLoadingMore(false);
    }
  }, [dependencies, notify, starredFolderIndex.data, starredFoldersLoadingMore]);

  const loadMoreProjectDocuments = useCallback(async () => {
    const data = project.data;
    if (!data?.nextDocumentCursor || projectDocumentsLoadingMore) return;
    setProjectDocumentsLoadingMore(true);
    try {
      if (!selectedFolderId) return;
      const next = await loadProjectDocumentPage(dependencies, selectedFolderId, data.nextDocumentCursor);
      setProject((current) => current.data?.project.id === data.project.id
        ? completePlannerLoad(current, {
          ...current.data,
          documents: mergePages(current.data.documents, next.items),
          nextDocumentCursor: next.nextCursor,
        })
        : current);
    } catch (error) {
      notify(`프로젝트 문서 더 보기 실패 · ${errorText(error)}`);
    } finally {
      setProjectDocumentsLoadingMore(false);
    }
  }, [dependencies, notify, project.data, projectDocumentsLoadingMore, selectedFolderId]);

  const loadMoreSubfolders = useCallback(async () => {
    const data = project.data;
    if (!selectedFolderId || !data?.nextSubfolderCursor || subfoldersLoadingMore) return;
    setSubfoldersLoadingMore(true);
    try {
      const page = await loadFolderSubfolderPage(dependencies, selectedFolderId, data.nextSubfolderCursor);
      setProject((current) => current.data?.project.id === data.project.id
        ? completePlannerLoad(current, {
          ...current.data,
          subfolders: [...new Map([...current.data.subfolders, ...page.items].map((folder) => [folder.id, folder])).values()],
          nextSubfolderCursor: page.nextCursor,
        })
        : current);
    } catch (error) {
      notify(`하위 폴더 더 보기 실패 · ${errorText(error)}`);
    } finally {
      setSubfoldersLoadingMore(false);
    }
  }, [dependencies, notify, project.data, selectedFolderId, subfoldersLoadingMore]);

  return {
    daily,
    todayFolderIds,
    setTaskTodayPresence,
    addTaskToToday,
    project,
    projects,
    selectedProject,
    starredFolders,
    starredFoldersHasMore: Boolean(starredFolderIndex.data?.nextCursor)
      && isStarredFolderRefreshCurrent(starredLoadedRefreshKey, refreshKeys.starred),
    starredFoldersLoading: (starredFolderIndex.status === "loading" && !starredFolderIndex.data)
      || !isStarredFolderRefreshCurrent(starredLoadedRefreshKey, refreshKeys.starred),
    starredFoldersLoadingMore,
    starredFoldersReordering,
    projectDocumentsLoadingMore,
    subfoldersLoadingMore,
    loadMoreStarredFolders,
    reorderStarredFolders,
    loadMoreProjectDocuments,
    loadMoreSubfolders,
    patchTask,
    removeSessions,
    moveSession,
    moveTaskProject,
    refreshDaily,
    refreshProject,
    refreshTask,
  };
}

function mergePages(first: readonly PageDto[], second: readonly PageDto[]): PageDto[] {
  return [...new Map([...first, ...second].map((page) => [page.id, page])).values()];
}

function mergeTasks(first: readonly PlannerFolder[], second: readonly PlannerFolder[]): PlannerFolder[] {
  return [...new Map([...first, ...second].map((task) => [task.page.id, task])).values()];
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}
