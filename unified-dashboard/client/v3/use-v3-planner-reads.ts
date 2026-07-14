import { useCallback, useEffect, useMemo, useState } from "react";
import type { PageApiClient, PageDto } from "@seosoyoung/soul-ui/page";

import type { PlannerLoadState } from "./PlannerViews";
import {
  applyAllProjectChanges,
  resolveSelectedProject,
  type ProjectStarChange,
} from "./project-star-store";
import {
  loadDailyPlanner,
  loadProjectDocumentPage,
  loadProjectIndex,
  loadProjectPlanner,
  loadProjectTaskPage,
  loadTaskRunHistory,
  type DailyPlannerData,
  type PlannerDataDependencies,
  type PlannerPage,
  type PlannerTask,
  type ProjectPlannerData,
} from "./planner-data";

const PROJECT_INDEX_PAGE_SIZE = 50;
const PROJECT_CONTENT_PAGE_SIZE = 20;
const RUN_HISTORY_PAGE_SIZE = 20;
const EMPTY_SESSION_IDS: string[] = [];

export function usePlannerCollections({
  api,
  dependencies,
  selectedDate,
  selectedProjectId,
  projectStarChanges,
  refreshKey,
  notify,
}: {
  api: PageApiClient;
  dependencies: PlannerDataDependencies;
  selectedDate: string;
  selectedProjectId: string | null;
  projectStarChanges: readonly ProjectStarChange[];
  refreshKey: number;
  notify(message: string): void;
}) {
  const [daily, setDaily] = useState<PlannerLoadState<DailyPlannerData>>({ status: "loading", data: null, message: null });
  const [project, setProject] = useState<PlannerLoadState<ProjectPlannerData>>({ status: "loading", data: null, message: null });
  const [projectIndex, setProjectIndex] = useState<PlannerLoadState<PlannerPage<PageDto>>>({ status: "loading", data: null, message: null });
  const [projectIndexLoadingMore, setProjectIndexLoadingMore] = useState(false);
  const [projectTasksLoadingMore, setProjectTasksLoadingMore] = useState(false);
  const [projectDocumentsLoadingMore, setProjectDocumentsLoadingMore] = useState(false);

  useEffect(() => {
    let active = true;
    setProjectIndex((current) => ({ status: "loading", data: current.data, message: null }));
    void loadProjectIndex(dependencies, { limit: PROJECT_INDEX_PAGE_SIZE }).then((data) => {
      if (active) setProjectIndex({ status: "ready", data, message: null });
    }).catch((error: unknown) => {
      if (active) {
        const message = errorText(error);
        setProjectIndex((current) => ({ status: "error", data: current.data, message }));
        notify(`프로젝트 인덱스 조회 실패 · ${message}`);
      }
    });
    return () => { active = false; };
  }, [dependencies, notify]);

  useEffect(() => {
    let active = true;
    setDaily((current) => ({ status: "loading", data: current.data, message: null }));
    void loadDailyPlanner(api, selectedDate, dependencies).then((data) => {
      if (active) setDaily({ status: "ready", data, message: null });
    }).catch((error: unknown) => {
      if (active) setDaily((current) => ({ status: "error", data: current.data, message: errorText(error) }));
    });
    return () => { active = false; };
  }, [api, dependencies, refreshKey, selectedDate]);

  const storedProjects = useMemo(
    () => mergePages(projectIndex.data?.items ?? [], daily.data?.projects ?? []),
    [daily.data?.projects, projectIndex.data?.items],
  );
  const projects = useMemo(
    () => applyAllProjectChanges(storedProjects, projectStarChanges),
    [projectStarChanges, storedProjects],
  );
  const selectedProject = useMemo(
    () => resolveSelectedProject(storedProjects, projectStarChanges, selectedProjectId),
    [projectStarChanges, selectedProjectId, storedProjects],
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

  const loadMoreProjects = useCallback(async () => {
    const cursor = projectIndex.data?.nextCursor;
    if (!cursor || projectIndexLoadingMore) return;
    setProjectIndexLoadingMore(true);
    try {
      const next = await loadProjectIndex(dependencies, { cursor, limit: PROJECT_INDEX_PAGE_SIZE });
      setProjectIndex((current) => current.data ? {
        status: "ready",
        data: { items: mergePages(current.data.items, next.items), nextCursor: next.nextCursor },
        message: null,
      } : current);
    } catch (error) {
      notify(`프로젝트 더 보기 실패 · ${errorText(error)}`);
    } finally {
      setProjectIndexLoadingMore(false);
    }
  }, [dependencies, notify, projectIndex.data?.nextCursor, projectIndexLoadingMore]);

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
    project,
    projects,
    selectedProject,
    projectIndexHasMore: Boolean(projectIndex.data?.nextCursor),
    projectIndexLoading: projectIndex.status === "loading" && !projectIndex.data,
    projectIndexLoadingMore,
    projectTasksLoadingMore,
    projectDocumentsLoadingMore,
    loadMoreProjects,
    loadMoreProjectTasks,
    loadMoreProjectDocuments,
  };
}

export function useTaskRunHistory({
  dependencies,
  task,
  workspaceOpen,
  notify,
}: {
  dependencies: PlannerDataDependencies;
  task: PlannerTask | null;
  workspaceOpen: boolean;
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
      notify(`Run 히스토리 조회 실패 · ${errorText(error)}`);
    });
    return () => { active = false; };
  }, [dependencies, latestRunKey, notify, task?.page.id, workspaceOpen]);

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
      notify(`이전 Run 더 보기 실패 · ${errorText(error)}`);
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
