import type {
  BoardItemType,
  BoardYjsContainerRef,
  CatalogBoardItemRow,
  FolderRow,
  ListContainerItemsParams,
  ListContainerItemsResult,
  TaskRow,
  SessionDB,
} from "../db/session_db.js";

const DEFAULT_LIMIT = 20;
const MAX_BROWSE_LIMIT = 100;
const MAX_SEARCH_LIMIT = 50;
export const CONTAINER_SEARCH_SCAN_LIMIT = 2_000;
const SESSION_PREVIEW_LIMIT = 120;
const MARKDOWN_PREVIEW_LIMIT = 240;
const LEGACY_BOARD_ITEM_LIMIT = 10_000;

export interface ContainerBrowseStore {
  getFolderById(folderId: string): Promise<FolderRow | null>;
  getTaskById(taskId: string): Promise<TaskRow | null>;
  listContainerItems(params: ListContainerItemsParams): Promise<ListContainerItemsResult>;
}

export interface ContainerBrowsePage {
  cursor: number;
  limit: number;
  total: number;
  nextCursor: number | null;
}

interface BaseContainerItem {
  boardItemId: string;
  archived: boolean;
  updatedAt: string | null;
}

export interface ContainerSessionItem extends BaseContainerItem {
  type: "session";
  agentSessionId: string;
  displayName: string;
  status: string | null;
  agentId: string | null;
  sessionType: string | null;
  createdAt: string | null;
  eventCount: number;
  awaySummary: string | null;
  callerSessionId: string | null;
  predecessorSessionId: string | null;
  nodeId: string | null;
  lastEventId: number | null;
  lastReadEventId: number | null;
}

export interface ContainerMarkdownItem extends BaseContainerItem {
  type: "markdown";
  id: string;
  title: string;
  preview: string;
}

export interface ContainerTitledItem extends BaseContainerItem {
  type: Exclude<BoardItemType, "session" | "markdown" | "frame">;
  id: string;
  title: string;
}

export interface ContainerFrameItem extends BaseContainerItem {
  type: "frame";
  id: string;
  title: string;
}

export type ContainerBrowseItem =
  | ContainerSessionItem
  | ContainerMarkdownItem
  | ContainerTitledItem
  | ContainerFrameItem;

export interface ContainerBrowseResult {
  container: BoardYjsContainerRef;
  items: ContainerBrowseItem[];
  page: ContainerBrowsePage;
  counts: ListContainerItemsResult["counts"];
  search?: {
    scanLimit: number;
    scannedItems: number;
    truncated: boolean;
  };
}

export class ContainerBrowseService {
  constructor(private readonly store: ContainerBrowseStore) {}

  async browse(params: {
    container: BoardYjsContainerRef;
    cursor?: number;
    limit?: number;
    includeArchived?: boolean;
  }): Promise<ContainerBrowseResult> {
    await this.assertContainer(params.container);
    return await this.read({
      container: params.container,
      cursor: normalizeCursor(params.cursor),
      limit: normalizeLimit(params.limit, MAX_BROWSE_LIMIT),
      includeArchived: params.includeArchived ?? false,
      query: null,
      itemTypes: null,
    });
  }

  async search(params: {
    container: BoardYjsContainerRef;
    query: string;
    limit?: number;
    includeArchived?: boolean;
  }): Promise<ContainerBrowseResult> {
    const query = params.query.trim();
    if (!query) throw new Error("query must not be empty");
    await this.assertContainer(params.container);
    return await this.read({
      container: params.container,
      cursor: 0,
      limit: normalizeLimit(params.limit, MAX_SEARCH_LIMIT),
      includeArchived: params.includeArchived ?? false,
      query,
      itemTypes: ["session", "markdown"],
      scanLimit: CONTAINER_SEARCH_SCAN_LIMIT,
    });
  }

  async browseLegacyFolder(params: {
    folderId: string;
    sessionCursor?: number;
    sessionLimit?: number;
  }): Promise<{
    sessions: ContainerBrowseResult;
    boardItems: CatalogBoardItemRow[];
  }> {
    const container = { containerKind: "folder", containerId: params.folderId } as const;
    await this.assertContainer(container);
    const [sessions, nonSessions] = await Promise.all([
      this.read({
        container,
        cursor: normalizeCursor(params.sessionCursor),
        limit: normalizeLimit(params.sessionLimit, MAX_BROWSE_LIMIT),
        includeArchived: false,
        query: null,
        itemTypes: ["session"],
      }),
      this.store.listContainerItems({
        container,
        cursor: 0,
        limit: LEGACY_BOARD_ITEM_LIMIT,
        includeArchived: false,
        query: null,
        itemTypes: ["markdown", "subfolder", "asset", "frame", "task", "custom_view"],
      }),
    ]);
    return {
      sessions,
      boardItems: nonSessions.items.map((item) => item.boardItem),
    };
  }

  private async read(params: ListContainerItemsParams): Promise<ContainerBrowseResult> {
    const result = await this.store.listContainerItems(params);
    return {
      container: params.container,
      items: result.items.map(toBrowseItem),
      page: {
        cursor: params.cursor,
        limit: params.limit,
        total: result.total,
        nextCursor: params.cursor + params.limit < result.total
          ? params.cursor + params.limit
          : null,
      },
      counts: result.counts,
      ...(result.scan
        ? {
            search: {
              scanLimit: result.scan.limit,
              scannedItems: result.scan.scannedItems,
              truncated: result.scan.truncated,
            },
          }
        : {}),
    };
  }

  private async assertContainer(container: BoardYjsContainerRef): Promise<void> {
    const row = container.containerKind === "folder"
      ? await this.store.getFolderById(container.containerId)
      : await this.store.getTaskById(container.containerId);
    if (!row) {
      throw new Error(`${container.containerKind} not found: ${container.containerId}`);
    }
  }
}

export function createContainerBrowseStore(db: SessionDB): ContainerBrowseStore {
  return {
    getFolderById: async (folderId) => await db.getFolderById(folderId),
    getTaskById: async (taskId) => await db.tasks().getTask(taskId),
    listContainerItems: async (params) => await db.listContainerItems(params),
  };
}

function toBrowseItem(record: ListContainerItemsResult["items"][number]): ContainerBrowseItem {
  const base = {
    boardItemId: record.boardItem.id,
    archived: record.archived,
    updatedAt: record.boardItem.updatedAt ?? null,
  };
  if (record.boardItem.itemType === "session") {
    const session = record.session;
    return {
      ...base,
      type: "session",
      agentSessionId: session?.agentSessionId ?? record.boardItem.itemId,
      displayName: readableText(session?.displayName)
        ?? readableText(session?.lastUserMessagePreview, SESSION_PREVIEW_LIMIT)
        ?? "제목 없는 세션",
      status: session?.status ?? null,
      agentId: session?.agentId ?? null,
      sessionType: session?.sessionType ?? null,
      createdAt: session?.createdAt ?? record.boardItem.createdAt ?? null,
      updatedAt: session?.updatedAt ?? base.updatedAt,
      eventCount: session?.eventCount ?? 0,
      awaySummary: session?.awaySummary ?? null,
      callerSessionId: session?.callerSessionId ?? null,
      predecessorSessionId: session?.predecessorSessionId ?? null,
      nodeId: session?.nodeId ?? null,
      lastEventId: session?.lastEventId ?? null,
      lastReadEventId: session?.lastReadEventId ?? null,
    };
  }
  if (record.boardItem.itemType === "markdown") {
    const markdown = record.markdown;
    return {
      ...base,
      type: "markdown",
      id: markdown?.id ?? record.boardItem.itemId,
      title: readableText(markdown?.title ?? record.boardItem.metadata.title)
        ?? "제목 없는 문서",
      preview: readableText(
        markdown?.body ?? record.boardItem.metadata.preview,
        MARKDOWN_PREVIEW_LIMIT,
      ) ?? "",
      updatedAt: markdown?.updatedAt ?? base.updatedAt,
    };
  }
  if (record.boardItem.itemType === "frame") {
    return {
      ...base,
      type: "frame",
      id: record.boardItem.itemId,
      title: readableText(record.boardItem.metadata.title) ?? "제목 없는 프레임",
    };
  }
  const titled = record.task ?? record.customView ?? record.asset ?? record.subfolder;
  return {
    ...base,
    type: record.boardItem.itemType,
    id: titled?.id ?? record.boardItem.itemId,
    title: readableText(titled?.title ?? record.boardItem.metadata.title)
      ?? untitledLabel(record.boardItem.itemType),
    updatedAt: record.subfolder ? base.updatedAt : record.task?.updatedAt
      ?? record.customView?.updatedAt
      ?? record.asset?.updatedAt
      ?? base.updatedAt,
  };
}

function readableText(value: unknown, maxCodepoints?: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (!normalized) return null;
  if (!maxCodepoints) return normalized;
  const codepoints = Array.from(normalized);
  if (codepoints.length <= maxCodepoints) return normalized;
  return `${codepoints.slice(0, maxCodepoints - 1).join("")}…`;
}

function normalizeCursor(cursor?: number): number {
  return Math.max(0, Math.trunc(cursor ?? 0));
}

function normalizeLimit(limit: number | undefined, max: number): number {
  return Math.min(max, Math.max(1, Math.trunc(limit ?? DEFAULT_LIMIT)));
}

function untitledLabel(itemType: BoardItemType): string {
  const labels: Partial<Record<BoardItemType, string>> = {
    task: "제목 없는 업무",
    custom_view: "제목 없는 커스텀뷰",
    asset: "이름 없는 파일",
    subfolder: "이름 없는 폴더",
  };
  return labels[itemType] ?? `제목 없는 ${itemType}`;
}
