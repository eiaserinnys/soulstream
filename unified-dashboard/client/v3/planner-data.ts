import { useCardStore } from "@seosoyoung/soul-ui/cards/card-store";
import type { CardRow } from "@seosoyoung/soul-ui/cards/card-types";
import type {
  BlockDto,
  PageApiClient,
  PageDto,
  PageReadResponse,
} from "@seosoyoung/soul-ui/page";
import { type CatalogFolder, type SessionSummary } from "@seosoyoung/soul-ui";

import {
  derivePlannerFolderStatus,
  folderContextCount,
  type PlannerFolderStatus,
} from "./planner-model";

export interface PlannerFolder {
  page: PageDto;
  blocks: BlockDto[];
  stateVector: string;
  folderId: string;
  status: PlannerFolderStatus;
  assignee: string;
  contextCount: number;
  progress: number | null;
  parentFolderId: string | null;
  sessionIds: string[];
}

export type StarredPlannerFolder = PlannerFolder | PageDto;

export function isPlannerFolder(value: StarredPlannerFolder): value is PlannerFolder {
  return "page" in value;
}

export function starredFolderPage(value: StarredPlannerFolder): PageDto {
  return isPlannerFolder(value) ? value.page : value;
}

export interface DailyPlannerData {
  attention: CardRow[];
  running: CardRow[];
  queued: CardRow[];
  daily: PageReadResponse;
  projects: PageDto[];
  memoBlocks: BlockDto[];
  folders: PlannerFolder[];
  reviewSessionIds: string[];
}

export interface FolderPlannerData {
  folder: CatalogFolder;
  project: PageDto;
  blocks: BlockDto[];
  cards: Array<{ status: string }>;
  subfolders: CatalogFolder[];
  nextSubfolderCursor: string | null;
  sessions: PlannerPage<SessionSummary>;
}

export interface PlannerPage<T> {
  items: T[];
  nextCursor: string | null;
}

export interface PlannerDataDependencies {
  fetchPlanner(path: string): Promise<unknown>;
  saveStarredFolderOrder?(pageId: string, beforePageId: string | null): Promise<void>;
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
      if (!response.ok) {
        const detail = await plannerResponseDetail(response);
        throw new Error([
          `플래너 요청 실패 (${response.status})`,
          detail,
        ].filter(Boolean).join("\n"));
      }
      return await response.json();
    },
    saveStarredFolderOrder: async (pageId, beforePageId) => {
      const response = await fetchImplementation("/api/planner/starred-folders/order", {
        method: "PATCH",
        credentials: "same-origin",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ pageId, beforePageId }),
      });
      if (!response.ok) {
        const detail = await plannerResponseDetail(response);
        throw new Error([
          `별표 순서 저장 실패 (${response.status})`,
          detail,
        ].filter(Boolean).join("\n"));
      }
      const payload = await response.json() as { ok?: unknown };
      if (payload?.ok !== true) throw new Error("별표 순서 저장 응답이 올바르지 않습니다.");
    },
  };
}

async function plannerResponseDetail(response: Response): Promise<string | null> {
  let raw: string;
  try {
    raw = await response.text();
  } catch {
    return null;
  }
  if (!raw.trim()) return null;
  try {
    const payload = JSON.parse(raw) as unknown;
    if (typeof payload === "string") return payload;
    if (!payload || typeof payload !== "object") return raw;
    const record = payload as Record<string, unknown>;
    const detail = record.detail;
    if (typeof detail === "string") return detail;
    if (detail && typeof detail === "object") {
      const message = (detail as Record<string, unknown>).message;
      if (typeof message === "string") return message;
    }
    if (typeof record.error === "string") return record.error;
    if (typeof record.message === "string") return record.message;
    return raw;
  } catch {
    return raw;
  }
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
  useCardStore.getState().putCards([...payload.attention, ...payload.running, ...payload.queued]);
  return {
    attention: payload.attention, running: payload.running, queued: payload.queued,
    daily: payload.daily,
    projects: [],
    folders: payload.folders.map(plannerFolder),
    memoBlocks: payload.memoBlocks,
    reviewSessionIds: payload.reviewSessionIds,
  };
}

export async function loadFolderPlanner(
  _api: PageApiClient,
  folderId: string,
  _project: PageDto,
  dependencies: PlannerDataDependencies,
): Promise<FolderPlannerData> {
  const payload = await dependencies.fetchPlanner(
    `/api/planner/folders/${encodeURIComponent(folderId)}`,
  ) as PlannerFolderAggregate;
  return {
    folder: payload.folder,
    project: payload.page,
    blocks: payload.blocks,
    cards: payload.cards,
    subfolders: payload.subfolders.items,
    nextSubfolderCursor: payload.subfolders.nextCursor,
    sessions: payload.sessions,
  };
}

export async function loadStarredFolders(
  dependencies: PlannerDataDependencies,
  input: { cursor?: string },
): Promise<PlannerPage<PlannerFolder>> {
  const payload = await dependencies.fetchPlanner(
    pagePath("/api/planner/starred-folders", input.cursor),
  ) as FolderSlicePayload<PlannerFolderPayload>;
  return {
    items: payload.items.map(plannerFolder),
    nextCursor: payload.nextCursor,
  };
}

export async function loadDailyHistoryDates(
  dependencies: PlannerDataDependencies,
  before: string,
): Promise<string[]> {
  const query = new URLSearchParams({ before });
  const payload = await dependencies.fetchPlanner(
    `/api/planner/daily-history?${query.toString()}`,
  ) as { dates: string[] };
  return payload.dates;
}

export async function loadFolderSubfolderPage(
  dependencies: PlannerDataDependencies,
  folderId: string,
  cursor: string,
): Promise<PlannerPage<CatalogFolder>> {
  const payload = await dependencies.fetchPlanner(pagePath(
    `/api/planner/folders/${encodeURIComponent(folderId)}/subfolders`, cursor,
  )) as FolderSlicePayload<CatalogFolder>;
  return { items: payload.items, nextCursor: payload.nextCursor };
}

export async function loadFolderSessionPage(
  dependencies: PlannerDataDependencies,
  folderId: string,
  cursor: string | undefined,
): Promise<PlannerPage<SessionSummary>> {
  const payload = await dependencies.fetchPlanner(
    pagePath(
      `/api/planner/folders/${encodeURIComponent(folderId)}/sessions`,
      cursor,
    ),
  ) as FolderSlicePayload<SessionSummary>;
  return payload;
}

export async function loadStarredPlannerFolder(
  api: PageApiClient,
  task: StarredPlannerFolder,
  folders: readonly CatalogFolder[],
): Promise<PlannerFolder> {
  if (isPlannerFolder(task)) return task;
  const folder = folders.find((candidate) => candidate.projectPageId === task.id);
  if (!folder) throw new Error("별표 폴더를 찾을 수 없습니다");
  return loadPlannerFolder(api, folder.id);
}

export async function loadPlannerFolderById(
  api: PageApiClient,
  folderId: string,
): Promise<PlannerFolder> {
  const payload = await createPlannerDataDependencies().fetchPlanner(
    `/api/planner/folders/${encodeURIComponent(folderId)}`,
  ) as PlannerFolderAggregate;
  return { ...plannerFolder({ folder: payload.folder, page: payload.page,
    itemCounts: {}, itemTotal: payload.cards.length,
    completedItemCount: payload.cards.filter((item) => item.status === "done").length,
    assignee: null }),
    blocks: payload.blocks,
    contextCount: folderContextCount(payload.blocks),
    sessionIds: payload.sessions.items.map((session) => session.agentSessionId),
  };
}

export async function loadPlannerFolder(
  _api: PageApiClient,
  folderId: string,
): Promise<PlannerFolder> {
  return loadPlannerFolderById(_api, folderId);
}

function pageQuery(cursor: string | undefined): URLSearchParams {
  const query = new URLSearchParams();
  if (cursor) query.set("cursor", cursor);
  return query;
}

function pagePath(path: string, cursor: string | undefined): string {
  const query = pageQuery(cursor).toString();
  return query ? `${path}?${query}` : path;
}

interface PlannerTodayPayload {
  attention: CardRow[]; running: CardRow[]; queued: CardRow[];
  daily: PageReadResponse;
  folders: PlannerFolderPayload[];
  memoBlocks: BlockDto[];
  reviewSessionIds: string[];
}

interface PlannerFolderPayload {
  folder: CatalogFolder;
  page: PageDto;
  itemCounts: Record<string, number>;
  itemTotal: number;
  completedItemCount: number;
  assignee: string | null;
}

interface PlannerFolderAggregate {
  folder: CatalogFolder;
  page: PageDto;
  blocks: BlockDto[];
  cards: Array<{ status: string }>;
  subfolders: FolderSlicePayload<CatalogFolder>;
  sessions: FolderSlicePayload<SessionSummary>;
}

interface FolderSlicePayload<T> {
  items: T[];
  nextCursor: string | null;
}

function plannerFolder(payload: PlannerFolderPayload): PlannerFolder {
  const { folder, page } = payload;
  return {
    page,
    blocks: [],
    stateVector: "",
    folderId: folder.id,
    status: derivePlannerFolderStatus({
      folder,
      cards: Object.entries(payload.itemCounts).filter(([, count]) => count > 0)
        .map(([status]) => ({ status })),
    }),
    assignee: payload.assignee ?? "담당 미지정",
    contextCount: 0,
    progress: payload.itemTotal > 0
      ? Math.round(100 * payload.completedItemCount / payload.itemTotal)
      : null,
    parentFolderId: folder.parentFolderId ?? null,
    sessionIds: [],
  };
}
