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
  refreshKeys,
  notify,
}: {
  api: PageApiClient;
  dependencies: PlannerDataDependencies;
  selectedDate: string;
  today: string;
  selectedProject: PageDto | null;
  taskStarChanges: readonly TaskStarChange[];
  refreshKeys: {
    daily: number;
    project: number;
    starred: number;
  };
  notify(message: string): void;
}) {
  const [daily, setDaily] = useState<PlannerLoadState<DailyPlannerData>>({ status: "loading", data: null, message: null });
  const [todayTaskIds, setTodayTaskIds] = useState<ReadonlySet<string>>(() => new Set());
  const [project, setProject] = useState<PlannerLoadState<ProjectPlannerData>>({ status: "loading", data: null, message: null });
  const [starredTaskIndex, setStarredTaskIndex] = useState<PlannerLoadState<PlannerPage<PageDto>>>({ status: "loading", data: null, message: null });
  const [starredTasksLoadingMore, setStarredTasksLoadingMore] = useState(false);
  const [projectTasksLoadingMore, setProjectTasksLoadingMore] = useState(false);
  const [projectDocumentsLoadingMore, setProjectDocumentsLoadingMore] = useState(false);
  const dailyRef = useRef(daily);
  const projectRef = useRef(project);
  const starredTaskIndexRef = useRef(starredTaskIndex);
  const stableProjectsRef = useRef<PageDto[]>([]);
  const stableStarredTasksRef = useRef<PageDto[]>([]);
  dailyRef.current = daily;
  projectRef.current = project;
  starredTaskIndexRef.current = starredTaskIndex;

  useEffect(() => {
    let active = true;
    const previous = starredTaskIndexRef.current.data;
    setStarredTaskIndex(beginPlannerLoad);
    void loadConfirmedResult({
      previous,
      load: () => loadStarredTasks(dependencies, { limit: STARRED_TASK_PAGE_SIZE }),
      clearsVisibleContent: (current, next) => current.items.length > 0 && next.items.length === 0,
    }).then((data) => {
      if (active) setStarredTaskIndex((current) => completePlannerLoad(current, data));
    }).catch((error: unknown) => {
      if (active) {
        const message = errorText(error);
        setStarredTaskIndex((current) => failPlannerLoad(current, message));
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
          setTodayTaskIds((current) => retainEqualSet(current, new Set(data.tasks.map((task) => task.page.id))));
        }
      }
    }).catch((error: unknown) => {
      if (active) setDaily((current) => failPlannerLoad(current, errorText(error)));
    });
    return () => { active = false; };
  }, [api, dependencies, refreshKeys.daily, selectedDate, today]);

  useEffect(() => {
    if (selectedDate === today) return;
    let active = true;
    void loadDailyPlanner(api, today, dependencies).then((data) => {
      if (active) {
        setTodayTaskIds((current) => retainEqualSet(current, new Set(data.tasks.map((task) => task.page.id))));
      }
    }).catch(() => {
      // The selected planner remains usable; its own error surface handles load failures.
    });
    return () => { active = false; };
  }, [api, dependencies, refreshKeys.daily, selectedDate, today]);

  const setTaskTodayPresence = useCallback((taskId: string, present: boolean) => {
    setTodayTaskIds((current) => {
      const next = new Set(current);
      if (present) next.add(taskId);
      else next.delete(taskId);
      return retainEqualSet(current, next);
    });
  }, []);

  const projects = useMemo(() => {
    const next = mergePages(daily.data?.projects ?? [], selectedProject ? [selectedProject] : []);
    stableProjectsRef.current = retainEqualValue(stableProjectsRef.current, next);
    return stableProjectsRef.current;
  }, [daily.data?.projects, selectedProject]);
  const starredTasks = useMemo(() => {
    const next = applyStarredTaskChanges(starredTaskIndex.data?.items ?? [], taskStarChanges);
    stableStarredTasksRef.current = retainEqualValue(stableStarredTasksRef.current, next);
    return stableStarredTasksRef.current;
  }, [starredTaskIndex.data?.items, taskStarChanges]);

  useEffect(() => {
    if (!selectedProject) return;
    let active = true;
    setProjectTasksLoadingMore(false);
    setProjectDocumentsLoadingMore(false);
    const previous = projectRef.current.data?.project.id === selectedProject.id
      ? projectRef.current.data
      : null;
    setProject((current) => current.data?.project.id === selectedProject.id
      ? beginPlannerLoad(current)
      : { status: "loading", data: null, message: null });
    void loadConfirmedResult({
      previous,
      load: () => loadProjectPlanner(api, selectedProject, dependencies),
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
  }, [api, dependencies, refreshKeys.project, selectedProject]);

  const loadMoreStarredTasks = useCallback(async () => {
    const cursor = starredTaskIndex.data?.nextCursor;
    if (!cursor || starredTasksLoadingMore) return;
    setStarredTasksLoadingMore(true);
    try {
      const next = await loadStarredTasks(dependencies, { cursor, limit: STARRED_TASK_PAGE_SIZE });
      setStarredTaskIndex((current) => current.data
        ? completePlannerLoad(current, {
          items: mergePages(current.data.items, next.items),
          nextCursor: next.nextCursor,
        })
        : current);
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
      setProject((current) => current.data?.project.id === data.project.id
        ? completePlannerLoad(current, {
          ...current.data,
          tasks: mergeTasks(current.data.tasks, next.items),
          nextTaskCursor: next.nextCursor,
        })
        : current);
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
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    if (!workspaceOpen || !task) {
      setState(null);
      return;
    }
    let active = true;
    const taskPageId = task.page.id;
    const initial = {
      taskPageId,
      sessionIds: [...task.sessionIds],
      nextCursor: null,
      total: task.sessionIds.length,
      loading: true,
    };
    const previous = stateRef.current?.taskPageId === taskPageId
      ? stateRef.current
      : null;
    setState((current) => current?.taskPageId === taskPageId
      ? retainEqualValue(current, { ...current, loading: true })
      : initial);
    void loadConfirmedResult({
      previous,
      load: async () => {
        const page = await loadTaskRunHistory(dependencies, taskPageId, undefined, RUN_HISTORY_PAGE_SIZE);
        return {
          taskPageId,
          sessionIds: mergeIds(task.sessionIds, page.sessionIds),
          nextCursor: page.nextCursor,
          total: page.total,
          loading: false,
        };
      },
      clearsVisibleContent: (current, next) => (
        current.sessionIds.length > 0 && next.sessionIds.length === 0
      ),
    }).then((next) => {
      if (!active) return;
      setState((current) => retainEqualValue(current ?? undefined, next));
    }).catch((error: unknown) => {
      if (!active) return;
      setState((current) => current?.taskPageId === taskPageId
        ? retainEqualValue(current, { ...current, loading: false })
        : current);
      notify(`세션 히스토리 조회 실패 · ${errorText(error)}`);
    });
    return () => { active = false; };
  }, [dependencies, latestRunKey, notify, refreshKey, task?.page.id, workspaceOpen]);

  const loadMore = useCallback(async () => {
    if (!task || !state?.nextCursor || state.loading || state.taskPageId !== task.page.id) return;
    const cursor = state.nextCursor;
    setState((current) => current ? retainEqualValue(current, { ...current, loading: true }) : current);
    try {
      const page = await loadTaskRunHistory(dependencies, task.page.id, cursor, RUN_HISTORY_PAGE_SIZE);
      setState((current) => current?.taskPageId === task.page.id
        ? retainEqualValue(current, {
          ...current,
          sessionIds: mergeIds(current.sessionIds, page.sessionIds),
          nextCursor: page.nextCursor,
          total: page.total,
          loading: false,
        })
        : current);
    } catch (error) {
      setState((current) => current ? retainEqualValue(current, { ...current, loading: false }) : current);
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
