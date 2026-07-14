import type {
  BlockDto,
  PageApiClient,
  PageDto,
  PageReadResponse,
} from "@seosoyoung/soul-ui/page";
import type { RunbookSnapshot } from "@seosoyoung/soul-ui/stores/runbook-store";

import {
  taskContextCount,
  type PlannerTaskStatus,
} from "./planner-model";

export interface PlannerTask {
  page: PageDto;
  blocks: BlockDto[];
  stateVector: string;
  runbookId: string;
  runbook: RunbookSnapshot | null;
  status: PlannerTaskStatus;
  assignee: string;
  contextCount: number;
  progress: number | null;
  projectPageId: string | null;
  sessionIds: string[];
  mountedDocuments: MountedTaskDocument[];
}

export interface MountedTaskDocument {
  blockId: string;
  page: PageDto;
}

export interface DailyPlannerData {
  daily: PageReadResponse;
  projects: PageDto[];
  memoBlocks: BlockDto[];
  tasks: PlannerTask[];
  reviewSessionIds: string[];
}

export interface ProjectPlannerData {
  project: PageDto;
  tasks: PlannerTask[];
  documents: PageDto[];
  nextTaskCursor: string | null;
  nextDocumentCursor: string | null;
}

export interface PlannerPage<T> {
  items: T[];
  nextCursor: string | null;
}

export interface TaskRunHistoryPage {
  sessionIds: string[];
  nextCursor: string | null;
  total: number;
}

export interface PlannerDataDependencies {
  fetchPlanner(path: string): Promise<unknown>;
}

export function createPlannerDataDependencies(
  fetchImplementation: typeof globalThis.fetch = globalThis.fetch,
): PlannerDataDependencies {
  return {
    fetchPlanner: async (path) => {
      const response = await fetchImplementation(path, {
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });
      if (!response.ok) throw new Error(`플래너를 불러오지 못했습니다 (${response.status})`);
      return await response.json();
    },
  };
}

export async function loadDailyPlanner(
  _api: PageApiClient,
  date: string,
  dependencies: PlannerDataDependencies,
): Promise<DailyPlannerData> {
  const query = new URLSearchParams({ date });
  const payload = await dependencies.fetchPlanner(
    `/api/planner/today?${query.toString()}`,
  ) as PlannerTodayPayload;
  return {
    daily: payload.daily,
    projects: payload.projects,
    tasks: payload.tasks.map(plannerTask),
    memoBlocks: payload.memo_blocks,
    reviewSessionIds: payload.review_session_ids,
  };
}

export async function loadProjectPlanner(
  _api: PageApiClient,
  project: PageDto,
  dependencies: PlannerDataDependencies,
): Promise<ProjectPlannerData> {
  const payload = await dependencies.fetchPlanner(
    `/api/planner/projects/${encodeURIComponent(project.id)}`,
  ) as PlannerProjectPayload;
  return {
    project: payload.project,
    tasks: payload.tasks.items.map(plannerTask),
    documents: payload.documents.items,
    nextTaskCursor: payload.tasks.next_cursor,
    nextDocumentCursor: payload.documents.next_cursor,
  };
}

export async function loadProjectIndex(
  dependencies: PlannerDataDependencies,
  input: { cursor?: string; limit: number },
): Promise<PlannerPage<PageDto>> {
  const query = pageQuery(input.cursor, input.limit);
  const payload = await dependencies.fetchPlanner(
    `/api/planner/project-index?${query.toString()}`,
  ) as PageSlicePayload<PageDto>;
  return plannerPage(payload);
}

export async function loadDailyHistoryDates(
  dependencies: PlannerDataDependencies,
  before: string,
  limit: number,
): Promise<string[]> {
  const query = new URLSearchParams({ before, limit: String(limit) });
  const payload = await dependencies.fetchPlanner(
    `/api/planner/daily-history?${query.toString()}`,
  ) as { dates: string[] };
  return payload.dates;
}

export async function loadProjectTaskPage(
  dependencies: PlannerDataDependencies,
  projectPageId: string,
  cursor: string | undefined,
  limit: number,
): Promise<PlannerPage<PlannerTask>> {
  const payload = await dependencies.fetchPlanner(
    `/api/planner/projects/${encodeURIComponent(projectPageId)}/tasks?${pageQuery(cursor, limit).toString()}`,
  ) as PageSlicePayload<PlannerTaskPayload>;
  return {
    items: payload.items.map(plannerTask),
    nextCursor: payload.next_cursor,
  };
}

export async function loadProjectDocumentPage(
  dependencies: PlannerDataDependencies,
  projectPageId: string,
  cursor: string | undefined,
  limit: number,
): Promise<PlannerPage<PageDto>> {
  const payload = await dependencies.fetchPlanner(
    `/api/planner/projects/${encodeURIComponent(projectPageId)}/documents?${pageQuery(cursor, limit).toString()}`,
  ) as PageSlicePayload<PageDto>;
  return plannerPage(payload);
}

export async function loadTaskRunHistory(
  dependencies: PlannerDataDependencies,
  taskPageId: string,
  cursor: string | undefined,
  limit: number,
): Promise<TaskRunHistoryPage> {
  const payload = await dependencies.fetchPlanner(
    `/api/planner/tasks/${encodeURIComponent(taskPageId)}/runs?${pageQuery(cursor, limit).toString()}`,
  ) as PageSlicePayload<{ agent_session_id: string }> & { total: number };
  return {
    sessionIds: payload.items.map((item) => item.agent_session_id),
    nextCursor: payload.next_cursor,
    total: payload.total,
  };
}

function pageQuery(cursor: string | undefined, limit: number): URLSearchParams {
  const query = new URLSearchParams();
  if (cursor) query.set("cursor", cursor);
  query.set("limit", String(limit));
  return query;
}

function plannerPage<T>(payload: PageSlicePayload<T>): PlannerPage<T> {
  return { items: payload.items, nextCursor: payload.next_cursor };
}

function plannerTask(payload: PlannerTaskPayload): PlannerTask {
  const runbook = payload.runbook ? minimalRunbook(payload.runbook) : null;
  return {
    page: payload.page,
    blocks: payload.blocks,
    stateVector: "",
    runbookId: payload.runbook_id,
    runbook,
    status: plannerSummaryStatus(payload.runbook),
    assignee: payload.runbook?.assignee ?? (payload.runbook ? "담당 미지정" : "담당 미확인"),
    contextCount: taskContextCount(payload.blocks),
    progress: plannerSummaryProgress(payload.runbook),
    projectPageId: payload.project_page_id,
    sessionIds: payload.sessions.map((session) => session.agent_session_id),
    mountedDocuments: payload.mounted_documents.map((document) => ({
      blockId: document.block_id,
      page: document.page,
    })),
  };
}

function plannerSummaryStatus(summary: PlannerRunbookSummaryPayload | null): PlannerTaskStatus {
  if (!summary) return "open";
  if (summary.status === "completed") return "completed";
  if ((summary.item_counts.review ?? 0) > 0) return "review";
  if ((summary.item_counts.in_progress ?? 0) > 0) return "in_progress";
  return "open";
}

function plannerSummaryProgress(summary: PlannerRunbookSummaryPayload | null): number | null {
  if (!summary || summary.item_total === 0) return null;
  return Math.round((summary.completed_item_count / summary.item_total) * 100);
}

function minimalRunbook(summary: PlannerRunbookSummaryPayload): RunbookSnapshot {
  return {
    runbook: {
      id: summary.id,
      board_item_id: summary.board_item_id,
      title: summary.title,
      status: summary.status === "completed" ? "completed" : "open",
      archived: summary.archived,
      version: summary.version,
      created_session_id: summary.created_session_id,
      created_event_id: summary.created_event_id,
      created_at: summary.created_at,
      updated_at: summary.updated_at,
    },
    sections: [],
    items: [],
  };
}

interface PlannerRunbookSummaryPayload {
  id: string;
  board_item_id: string;
  title: string;
  status: string;
  archived: boolean;
  version: number;
  created_session_id: string | null;
  created_event_id: number | null;
  created_at: string;
  updated_at: string;
  item_counts: Record<string, number>;
  item_total: number;
  completed_item_count: number;
  assignee: string | null;
}

interface PlannerTaskPayload {
  page: PageDto;
  blocks: BlockDto[];
  runbook_id: string;
  runbook: PlannerRunbookSummaryPayload | null;
  project_page_id: string | null;
  sessions: Array<{ agent_session_id: string }>;
  mounted_documents: Array<{ block_id: string; page: PageDto }>;
}

interface PlannerTodayPayload {
  daily: PageReadResponse;
  projects: PageDto[];
  memo_blocks: BlockDto[];
  tasks: PlannerTaskPayload[];
  review_session_ids: string[];
}

interface PlannerProjectPayload {
  project: PageDto;
  tasks: PageSlicePayload<PlannerTaskPayload>;
  documents: PageSlicePayload<PageDto>;
}

interface PageSlicePayload<T> {
  items: T[];
  next_cursor: string | null;
}
