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
}

export interface ProjectPlannerData {
  project: PageDto;
  tasks: PlannerTask[];
  documents: PageDto[];
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
    tasks: payload.tasks.map(plannerTask),
    documents: payload.documents,
  };
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
}

interface PlannerProjectPayload {
  project: PageDto;
  tasks: PlannerTaskPayload[];
  documents: PageDto[];
}

export async function listAllPages(api: PageApiClient, starred?: boolean): Promise<PageDto[]> {
  const pages: PageDto[] = [];
  const visited = new Set<string>();
  let cursor: string | undefined;
  do {
    const response = await api.listPages({ starred, cursor, limit: 100 });
    pages.push(...response.items);
    const next = response.next_cursor ?? undefined;
    if (!next || visited.has(next)) break;
    visited.add(next);
    cursor = next;
  } while (cursor);
  return pages;
}
