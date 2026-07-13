import type {
  BlockDto,
  PageApiClient,
  PageDto,
  PageReadResponse,
} from "@seosoyoung/soul-ui/page";
import type { RunbookSnapshot } from "@seosoyoung/soul-ui/stores/runbook-store";
import { fetchRunbookSnapshot } from "@seosoyoung/soul-ui/stores/runbook-api";

import {
  classifyMountedPage,
  derivePlannerTaskStatus,
  parseSingleMountTitle,
  plannerProgress,
  taskAssignee,
  taskContextCount,
  type PlannerTaskStatus,
} from "./planner-model";

export interface PlannerTask {
  page: PageDto;
  blocks: BlockDto[];
  runbookId: string;
  runbook: RunbookSnapshot | null;
  status: PlannerTaskStatus;
  assignee: string;
  contextCount: number;
  progress: number | null;
  projectPageId: string | null;
  sessionIds: string[];
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
  fetchRunbook(runbookId: string): Promise<RunbookSnapshot | null>;
  fetchRunbookSessionIds(runbookId: string): Promise<string[]>;
}

export function createPlannerDataDependencies(
  fetchImplementation: typeof globalThis.fetch = globalThis.fetch,
): PlannerDataDependencies {
  return {
    fetchRunbook: fetchRunbookSnapshot,
    fetchRunbookSessionIds: async (runbookId) => {
      const query = new URLSearchParams({
        container_kind: "runbook",
        container_id: runbookId,
      });
      const response = await fetchImplementation(`/api/board-items?${query.toString()}`, {
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });
      if (!response.ok) throw new Error(`Run 목록을 불러오지 못했습니다 (${response.status})`);
      const payload = await response.json() as { boardItems?: unknown[] };
      return (payload.boardItems ?? []).flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const record = item as Record<string, unknown>;
        return record.itemType === "session" && typeof record.itemId === "string"
          ? [record.itemId]
          : [];
      });
    },
  };
}

export async function loadDailyPlanner(
  api: PageApiClient,
  date: string,
  dependencies: PlannerDataDependencies,
): Promise<DailyPlannerData> {
  const dailyResponse = await api.getDailyPage(date);
  const [daily, projects, allPages] = await Promise.all([
    api.getPage(dailyResponse.page.id),
    listAllPages(api, true),
    listAllPages(api),
  ]);
  const mountedPages = await readMountedPages(api, daily.blocks, allPages);
  const projectIds = new Set(projects.map((project) => project.id));
  const tasks = (await Promise.all(mountedPages.map(async (mounted) => {
    const classification = classifyMountedPage(mounted.blocks);
    if (classification.kind === "document") return null;
    const projectPageId = await findMountedProject(api, mounted.page.id, projectIds);
    return await buildTask(mounted, classification.runbookId, projectPageId, dependencies);
  }))).filter((task): task is PlannerTask => task !== null);
  return {
    daily,
    projects,
    tasks,
    memoBlocks: daily.blocks.filter((block) => (
      block.block_type === "paragraph" && parseSingleMountTitle(block) === null
    )),
  };
}

export async function loadProjectPlanner(
  api: PageApiClient,
  project: PageDto,
  dependencies: PlannerDataDependencies,
): Promise<ProjectPlannerData> {
  const [projectRead, allPages] = await Promise.all([
    api.getPage(project.id),
    listAllPages(api),
  ]);
  const mountedPages = (await readMountedPages(api, projectRead.blocks, allPages)).reverse();
  const tasks: PlannerTask[] = [];
  const documents: PageDto[] = [];
  for (const mounted of mountedPages) {
    const classification = classifyMountedPage(mounted.blocks);
    if (classification.kind === "document") {
      documents.push(mounted.page);
      continue;
    }
    tasks.push(await buildTask(
      mounted,
      classification.runbookId,
      project.id,
      dependencies,
    ));
  }
  return { project, tasks, documents };
}

async function buildTask(
  mounted: PageReadResponse,
  runbookId: string,
  projectPageId: string | null,
  dependencies: PlannerDataDependencies,
): Promise<PlannerTask> {
  const [runbook, sessionIds] = await Promise.all([
    dependencies.fetchRunbook(runbookId).catch((error: unknown) => {
      console.warn(`[v3 planner] Runbook ${runbookId} could not be loaded`, error);
      return null;
    }),
    dependencies.fetchRunbookSessionIds(runbookId).catch((error: unknown) => {
      console.warn(`[v3 planner] Run list for ${runbookId} could not be loaded`, error);
      return [];
    }),
  ]);
  return {
    page: mounted.page,
    blocks: mounted.blocks,
    runbookId,
    runbook,
    status: runbook ? derivePlannerTaskStatus(runbook) : "open",
    assignee: taskAssignee(runbook),
    contextCount: taskContextCount(mounted.blocks),
    progress: plannerProgress(runbook),
    projectPageId,
    sessionIds,
  };
}

async function readMountedPages(
  api: PageApiClient,
  blocks: readonly BlockDto[],
  pages: readonly PageDto[],
): Promise<PageReadResponse[]> {
  const pageByTitle = new Map<string, PageDto>();
  for (const page of pages) {
    if (!pageByTitle.has(page.title)) pageByTitle.set(page.title, page);
  }
  const mountedIds = blocks.flatMap((block) => {
    const title = parseSingleMountTitle(block);
    const page = title ? pageByTitle.get(title) : undefined;
    return page ? [page.id] : [];
  });
  return await Promise.all([...new Set(mountedIds)].map((pageId) => api.getPage(pageId)));
}

async function findMountedProject(
  api: PageApiClient,
  taskPageId: string,
  projectIds: ReadonlySet<string>,
): Promise<string | null> {
  try {
    const backlinks = await api.getBacklinks(taskPageId, { kinds: ["mount"], limit: 50 });
    return backlinks.items.find((item) => projectIds.has(item.sourcePageId))?.sourcePageId ?? null;
  } catch (error) {
    console.warn(`[v3 planner] Project backlink for ${taskPageId} could not be loaded`, error);
    return null;
  }
}

async function listAllPages(api: PageApiClient, starred?: boolean): Promise<PageDto[]> {
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
