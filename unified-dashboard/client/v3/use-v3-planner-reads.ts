import { useCallback, useEffect, useMemo, useState } from "react";
import type { PageApiClient, PageDto } from "@seosoyoung/soul-ui/page";

import type { PlannerLoadState } from "./PlannerViews";
import { applyStarredTaskChanges, type TaskStarChange } from "./task-star-store";
import {
  loadDailyPlanner,
  loadProjectDocumentPage,
  loadStarredTasks,
  loadProjectPlanner,
  loadProjectTaskPage,
  loadTaskRunHistory,
  type DailyPlannerData,
  type PlannerDataDependencies,
  type PlannerPage,
  type PlannerTask,
  type ProjectPlannerData,
} from "./planner-data";

const STARRED_TASK_PAGE_SIZE = 50;
const PROJECT_CONTENT_PAGE_SIZE = 20;
const RUN_HISTORY_PAGE_SIZE = 20;
const EMPTY_SESSION_IDS: string[] = [];

export function usePlannerCollections({
  api,
  dependencies,
  selectedDate,
  today,
  selectedProject,
  taskStarChanges,
  refreshKey,
  notify,
}: {
  api: PageApiClient;
  dependencies: PlannerDataDependencies;
  selectedDate: string;
  today: string;
  selectedProject: PageDto | null;
  taskStarChanges: readonly TaskStarChange[];
  refreshKey: number;
  notify(message: string): void;
}) {
  const [daily, setDaily] = useState<PlannerLoadState<DailyPlannerData>>({ status: "loading", data: null, message: null });
  const [todayTaskIds, setTodayTaskIds] = useState<ReadonlySet<string>>(() => new Set());
  const [project, setProject] = useState<PlannerLoadState<ProjectPlannerData>>({ status: "loading", data: null, message: null });
  const [starredTaskIndex, setStarredTaskIndex] = useState<PlannerLoadState<PlannerPage<PageDto>>>({ status: "loading", data: null, message: null });
  const [starredTasksLoadingMore, setStarredTasksLoadingMore] = useState(false);
  const [projectTasksLoadingMore, setProjectTasksLoadingMore] = useState(false);
  const [projectDocumentsLoadingMore, setProjectDocumentsLoadingMore] = useState(false);

  useEffect(() => {
    let active = true;
    setStarredTaskIndex((current) => ({ status: "loading", data: current.data, message: null }));
    void loadStarredTasks(dependencies, { limit: STARRED_TASK_PAGE_SIZE }).then((data) => {
      if (active) setStarredTaskIndex({ status: "ready", data, message: null });
    }).catch((error: unknown) => {
      if (active) {
        const message = errorText(error);
        setStarredTaskIndex((current) => ({ status: "error", data: current.data, message }));
        notify(`별표 업무 조회 실패 · ${message}`);
      }
    });
    return () => { active = false; };
  }, [dependencies, notify, refreshKey]);

  useEffect(() => {
    let active = true;
    setDaily((current) => ({ status: "loading", data: current.data, message: null }));
    void loadDailyPlanner(api, selectedDate, dependencies).then((data) => {
      if (active) {
        setDaily({ status: "ready", data, message: null });
        if (selectedDate === today) {
          setTodayTaskIds(new Set(data.tasks.map((task) => task.page.id)));
        }
      }
    }).catch((error: unknown) => {
      if (active) setDaily((current) => ({ status: "error", data: current.data, message: errorText(error) }));
    });
    return () => { active = false; };
  }, [api, dependencies, refreshKey, selectedDate, today]);

  useEffect(() => {
    if (selectedDate === today) return;
    let active = true;
    void loadDailyPlanner(api, today, dependencies).then((data) => {
      if (active) setTodayTaskIds(new Set(data.tasks.map((task) => task.page.id)));
    }).catch(() => {
      // The selected planner remains usable; its own error surface handles load failures.
    });
    return () => { active = false; };
  }, [api, dependencies, refreshKey, selectedDate, today]);

  const setTaskTodayPresence = useCallback((taskId: string, present: boolean) => {
    setTodayTaskIds((current) => {
      const next = new Set(current);
      if (present) next.add(taskId);
      else next.delete(taskId);
      return next;
    });
  }, []);

  const projects = useMemo(
    () => mergePages(daily.data?.projects ?? [], selectedProject ? [selectedProject] : []),
    [daily.data?.projects, selectedProject],
  );
  const starredTasks = useMemo(
    () => applyStarredTaskChanges(starredTaskIndex.data?.items ?? [], taskStarChanges),
    [starredTaskIndex.data?.items, taskStarChanges],
  );

  useEffect(() => {
    if (!selectedProject) return;
    let active = true;
    setProjectTasksLoadingMore(false);
    setProjectDocumentsLoadingMore(false);
    setProject((current) => ({
      status: "loading",
      data: current.data?.project.id === selectedProject.id ? current.data : null,
      message: null,
    }));
    void loadProjectPlanner(api, selectedProject, dependencies).then((data) => {
      if (active) setProject({ status: "ready", data, message: null });
    }).catch((error: unknown) => {
      if (active) setProject((current) => ({ status: "error", data: current.data, message: errorText(error) }));
    });
    return () => { active = false; };
  }, [api, dependencies, refreshKey, selectedProject]);

  const loadMoreStarredTasks = useCallback(async () => {
    const cursor = starredTaskIndex.data?.nextCursor;
    if (!cursor || starredTasksLoadingMore) return;
    setStarredTasksLoadingMore(true);
    try {
      const next = await loadStarredTasks(dependencies, { cursor, limit: STARRED_TASK_PAGE_SIZE });
      setStarredTaskIndex((current) => current.data ? {
        status: "ready",
        data: { items: mergePages(current.data.items, next.items), nextCursor: next.nextCursor },
        message: null,
      } : current);
    } catch (error) {
      notify(`별표 업무 더 보기 실패 · ${errorText(error)}`);
    } finally {
      setStarredTasksLoadingMore(false);
    }
  }, [dependencies, notify, starredTaskIndex.data?.nextCursor, starredTasksLoadingMore]);

  const loadMoreProjectTasks = useCallback(async () => {
    const data = project.data;
    if (!data?.nextTaskCursor || projectTasksLoadingMore) return;
    setProjectTasksLoadingMore(true);
    try {
      const next = await loadProjectTaskPage(dependencies, data.project.id, data.nextTaskCursor, PROJECT_CONTENT_PAGE_SIZE);
      setProject((current) => current.data?.project.id === data.project.id ? {
        status: "ready",
        data: { ...current.data, tasks: mergeTasks(current.data.tasks, next.items), nextTaskCursor: next.nextCursor },
        message: null,
      } : current);
    } catch (error) {
      notify(`프로젝트 업무 더 보기 실패 · ${errorText(error)}`);
    } finally {
      setProjectTasksLoadingMore(false);
    }
  }, [dependencies, notify, project.data, projectTasksLoadingMore]);

  const loadMoreProjectDocuments = useCallback(async () => {
    const data = project.data;
    if (!data?.nextDocumentCursor || projectDocumentsLoadingMore) return;
    setProjectDocumentsLoadingMore(true);
    try {
      const next = await loadProjectDocumentPage(dependencies, data.project.id, data.nextDocumentCursor, PROJECT_CONTENT_PAGE_SIZE);
      setProject((current) => current.data?.project.id === data.project.id ? {
        status: "ready",
        data: { ...current.data, documents: mergePages(current.data.documents, next.items), nextDocumentCursor: next.nextCursor },
        message: null,
      } : current);
    } catch (error) {
      notify(`프로젝트 문서 더 보기 실패 · ${errorText(error)}`);
    } finally {
      setProjectDocumentsLoadingMore(false);
    }
  }, [dependencies, notify, project.data, projectDocumentsLoadingMore]);

  return {
    daily,
    todayTaskIds,
    setTaskTodayPresence,
    project,
    projects,
    selectedProject,
    starredTasks,
    starredTasksHasMore: Boolean(starredTaskIndex.data?.nextCursor),
    starredTasksLoading: starredTaskIndex.status === "loading" && !starredTaskIndex.data,
    starredTasksLoadingMore,
    projectTasksLoadingMore,
    projectDocumentsLoadingMore,
    loadMoreStarredTasks,
    loadMoreProjectTasks,
    loadMoreProjectDocuments,
  };
}

export function useTaskRunHistory({
  dependencies,
  task,
  workspaceOpen,
  refreshKey,
  notify,
}: {
  dependencies: PlannerDataDependencies;
  task: PlannerTask | null;
  workspaceOpen: boolean;
  refreshKey: number;
  notify(message: string): void;
}) {
  const latestRunKey = task?.sessionIds.join("\0") ?? "";
  const [state, setState] = useState<{
    taskPageId: string;
    sessionIds: string[];
    nextCursor: string | null;
    total: number;
    loading: boolean;
  } | null>(null);

  useEffect(() => {
    if (!workspaceOpen || !task) {
      setState(null);
      return;
    }
    let active = true;
    const taskPageId = task.page.id;
    setState({
      taskPageId,
      sessionIds: [...task.sessionIds],
      nextCursor: null,
      total: task.sessionIds.length,
      loading: true,
    });
    void loadTaskRunHistory(dependencies, taskPageId, undefined, RUN_HISTORY_PAGE_SIZE).then((page) => {
      if (!active) return;
      setState({
        taskPageId,
        sessionIds: mergeIds(task.sessionIds, page.sessionIds),
        nextCursor: page.nextCursor,
        total: page.total,
        loading: false,
      });
    }).catch((error: unknown) => {
      if (!active) return;
      setState((current) => current?.taskPageId === taskPageId ? { ...current, loading: false } : current);
      notify(`세션 히스토리 조회 실패 · ${errorText(error)}`);
    });
    return () => { active = false; };
  }, [dependencies, latestRunKey, notify, refreshKey, task?.page.id, workspaceOpen]);

  const loadMore = useCallback(async () => {
    if (!task || !state?.nextCursor || state.loading || state.taskPageId !== task.page.id) return;
    const cursor = state.nextCursor;
    setState((current) => current ? { ...current, loading: true } : current);
    try {
      const page = await loadTaskRunHistory(dependencies, task.page.id, cursor, RUN_HISTORY_PAGE_SIZE);
      setState((current) => current?.taskPageId === task.page.id ? {
        ...current,
        sessionIds: mergeIds(current.sessionIds, page.sessionIds),
        nextCursor: page.nextCursor,
        total: page.total,
        loading: false,
      } : current);
    } catch (error) {
      setState((current) => current ? { ...current, loading: false } : current);
      notify(`이전 세션 더 보기 실패 · ${errorText(error)}`);
    }
  }, [dependencies, notify, state, task]);

  const current = state?.taskPageId === task?.page.id ? state : null;
  return {
    sessionIds: current?.sessionIds ?? task?.sessionIds ?? EMPTY_SESSION_IDS,
    total: current?.total ?? task?.sessionIds.length ?? 0,
    hasMore: Boolean(current?.nextCursor),
    loading: current?.loading ?? false,
    loadMore,
  };
}

function mergePages(first: readonly PageDto[], second: readonly PageDto[]): PageDto[] {
  return [...new Map([...first, ...second].map((page) => [page.id, page])).values()];
}

function mergeTasks(first: readonly PlannerTask[], second: readonly PlannerTask[]): PlannerTask[] {
  return [...new Map([...first, ...second].map((task) => [task.page.id, task])).values()];
}

function mergeIds(first: readonly string[], second: readonly string[]): string[] {
  return [...new Set([...first, ...second])];
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}
