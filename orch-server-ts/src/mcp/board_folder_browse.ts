import type { BoardItemType, CatalogBoardItemRow } from "../board-yjs/board_yjs_types.js";
import type { ListFolderItemsParams, ListFolderItemsResult } from "../board-yjs/board_projection_types.js";
import type { BoardMcpStore, FolderRow } from "./board_catalog_types.js";
import { FOLDER_SEARCH_SCAN_LIMIT } from "@soulstream/mcp-contract";

const DEFAULT_LIMIT = 20;
const MAX_BROWSE_LIMIT = 100;
const MAX_SEARCH_LIMIT = 50;

const SESSION_PREVIEW_LIMIT = 120;
const MARKDOWN_PREVIEW_LIMIT = 240;
const BOARD_ITEM_LIMIT = 10_000;

export interface FolderBrowseStore {
  getFolderById(folderId: string): Promise<FolderRow | null>;
  listFolderItems(params: ListFolderItemsParams): Promise<ListFolderItemsResult>;
}

export interface FolderBrowsePage {
  cursor: number;
  limit: number;
  total: number;
  nextCursor: number | null;
}

interface BaseFolderItem {
  boardItemId: string;
  archived: boolean;
  updatedAt: string | null;
}

export interface FolderSessionItem extends BaseFolderItem {
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

export interface FolderMarkdownItem extends BaseFolderItem {
  type: "markdown";
  id: string;
  title: string;
  preview: string;
}

export interface FolderTitledItem extends BaseFolderItem {
  type: Exclude<BoardItemType, "session" | "markdown" | "frame">;
  id: string;
  title: string;
}

export interface FolderFrameItem extends BaseFolderItem {
  type: "frame";
  id: string;
  title: string;
}

export type FolderBrowseItem =
  | FolderSessionItem
  | FolderMarkdownItem
  | FolderTitledItem
  | FolderFrameItem;

export interface FolderBrowseResult {
  folderId: string;
  items: FolderBrowseItem[];
  page: FolderBrowsePage;
  counts: ListFolderItemsResult["counts"];
  search?: {
    scanLimit: number;
    scannedItems: number;
    truncated: boolean;
  };
}

export class FolderBrowseService {
  constructor(private readonly store: FolderBrowseStore) {}

  async browse(params: {
    folderId: string;
    cursor?: number;
    limit?: number;
    includeArchived?: boolean;
  }): Promise<FolderBrowseResult> {
    await this.assertFolder(params.folderId);
    return await this.read({
      folderId: params.folderId,
      cursor: normalizeCursor(params.cursor),
      limit: normalizeLimit(params.limit, MAX_BROWSE_LIMIT),
      includeArchived: params.includeArchived ?? false,
      query: null,
      itemTypes: null,
    });
  }

  async search(params: {
    folderId: string;
    query: string;
    limit?: number;
    includeArchived?: boolean;
  }): Promise<FolderBrowseResult> {
    const query = params.query.trim();
    if (!query) throw new Error("query must not be empty");
    await this.assertFolder(params.folderId);
    return await this.read({
      folderId: params.folderId,
      cursor: 0,
      limit: normalizeLimit(params.limit, MAX_SEARCH_LIMIT),
      includeArchived: params.includeArchived ?? false,
      query,
      itemTypes: ["session", "markdown"],
      scanLimit: FOLDER_SEARCH_SCAN_LIMIT,
    });
  }

  async browseFolderContents(params: {
    folderId: string;
    sessionCursor?: number;
    sessionLimit?: number;
  }): Promise<{ sessions: FolderBrowseResult; boardItems: CatalogBoardItemRow[] }> {
    await this.assertFolder(params.folderId);
    const [sessions, otherItems] = await Promise.all([
      this.read({
        folderId: params.folderId,
        cursor: normalizeCursor(params.sessionCursor),
        limit: normalizeLimit(params.sessionLimit, MAX_BROWSE_LIMIT),
        includeArchived: false,
        query: null,
        itemTypes: ["session"],
      }),
      this.store.listFolderItems({
        folderId: params.folderId,
        cursor: 0,
        limit: BOARD_ITEM_LIMIT,
        includeArchived: false,
        query: null,
        itemTypes: ["markdown", "subfolder", "asset", "frame", "custom_view"],
      }),
    ]);
    return { sessions, boardItems: otherItems.items.map((item) => item.boardItem) };
  }

  private async read(params: ListFolderItemsParams): Promise<FolderBrowseResult> {
    const result = await this.store.listFolderItems(params);
    return {
      folderId: params.folderId,
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
      ...(result.scan ? { search: {
        scanLimit: result.scan.limit,
        scannedItems: result.scan.scannedItems,
        truncated: result.scan.truncated,
      } } : {}),
    };
  }

  private async assertFolder(folderId: string): Promise<void> {
    if (!await this.store.getFolderById(folderId)) {
      throw new Error(`folder not found: ${folderId}`);
    }
  }
}

export function createFolderBrowseStore(db: BoardMcpStore): FolderBrowseStore {
  return {
    getFolderById: async (folderId) => await db.getFolderById(folderId),
    listFolderItems: async (params) => await db.listFolderItems(params),
  };
}

function toBrowseItem(record: ListFolderItemsResult["items"][number]): FolderBrowseItem {
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
  const titled = record.customView ?? record.asset ?? record.subfolder;
  return {
    ...base,
    type: record.boardItem.itemType,
    id: titled?.id ?? record.boardItem.itemId,
    title: readableText(titled?.title ?? record.boardItem.metadata.title)
      ?? untitledLabel(record.boardItem.itemType),
    updatedAt: record.subfolder ? base.updatedAt :  record.customView?.updatedAt
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
    custom_view: "제목 없는 커스텀뷰",
    asset: "이름 없는 파일",
    subfolder: "이름 없는 폴더",
  };
  return labels[itemType] ?? `제목 없는 ${itemType}`;
}
