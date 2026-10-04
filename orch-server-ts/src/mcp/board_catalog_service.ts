// Orchestrator-owned MCP catalog composition; legacy worker service remains for other callers.
import { randomUUID } from "node:crypto";
import type { CatalogBoardItemRow, MarkdownDocumentRow } from "../board-yjs/board_yjs_types.js";
import type { BoardMcpStore, BoardMcpFolderMutations } from "./board_catalog_types.js";
import { CatalogBoardItemService, type CatalogBoardItemMoveResult, type CatalogBoardYjsPort } from "./board_catalog_items.js";
import { boardItemsDelta, serializeCatalogFolders, sessionAssignmentFromRow, type CatalogMutationDelta, type CatalogSessionsDelta } from "./board_catalog_delta.js";
import { FolderBrowseService, type FolderBrowseResult, type FolderBrowseItem, type FolderSessionItem, createFolderBrowseStore } from "./board_folder_browse.js";
import type { CustomViewBroadcasterPort } from "./board_custom_view_service.js";

export interface CatalogFolderDto {
  id: string;
  name: string;
  sortOrder: number;
  settings: Record<string, unknown>;
  parentFolderId: string | null;
  projectPageId?: string | null;
  createdAt?: string;
}

export interface BrowseFolderSessionDto {
  sessionId: string;
  title: string;
  displayName: string | null;
  status: string | null;
  sessionType: string | null;
  createdAt: string;
  updatedAt: string;
  eventCount: number;
  awaySummary: string | null;
  callerSessionId: string | null;
  predecessorSessionId: string | null;
  nodeId: string | null;
  lastEventId: number | null;
  lastReadEventId: number | null;
}

export interface BrowseFolderResult {
  folderId: string;
  folder: CatalogFolderDto;
  childFolders: CatalogFolderDto[];
  sessions: BrowseFolderSessionDto[];
  sessionsPage: {
    cursor: number;
    limit: number;
    total: number;
    nextCursor: number | null;
  };
  boardItems: CatalogBoardItemRow[];
  items: FolderBrowseItem[];
  itemsPage: FolderBrowseResult["page"];
  counts: {
    childFolders: number;
    sessions: number;
    boardItems: number;
    documents: number;
    assets: number;
  };
}

export class CatalogService {
  private readonly boardItems: CatalogBoardItemService;
  private readonly folderBrowser: FolderBrowseService;

  constructor(
    private readonly db: BoardMcpStore,
    private readonly broadcaster: Required<Pick<CustomViewBroadcasterPort, "emitCatalogUpdated">>,
    boardYjsService: CatalogBoardYjsPort,
    private readonly folderService: BoardMcpFolderMutations,
  ) {
    this.boardItems = new CatalogBoardItemService(
      db,
      boardYjsService,
      (delta) => this.broadcastCatalog(delta),
    );
    this.folderBrowser = new FolderBrowseService(createFolderBrowseStore(db));
  }

  async listFolders(): Promise<CatalogFolderDto[]> {
    return serializeCatalogFolders(await this.db.getAllFolders());
  }

  async listChildFolders(folderId: string | null): Promise<CatalogFolderDto[]> {
    const folders = await this.listFolders();
    return folders.filter((folder) => folder.parentFolderId === folderId);
  }

  /**
   * MCP browse용 읽기 스냅샷.
   *
   * "폴더 안에 무엇이 있나"는 folders, sessions, board_items 세 정본을 함께 봐야 한다.
   * 이 메서드는 mutation 없이 직접 자식 폴더, 세션 페이지, 문서/파일 보드 항목을 한 번에
   * 반환하여 MCP 호출자가 여러 도구를 조합하다가 누락을 만들지 않게 한다.
   */
  async browseFolder(params: {
    folderId: string;
    sessionCursor?: number;
    sessionLimit?: number;
    cursor?: number;
    limit?: number;
    includeArchived?: boolean;
  }): Promise<BrowseFolderResult> {
    const folders = await this.listFolders();
    const folder = folders.find((candidate) => candidate.id === params.folderId);
    if (!folder) {
      throw new Error(`folder not found: ${params.folderId}`);
    }
    const childFolders = folders.filter(
      (candidate) => candidate.parentFolderId === params.folderId,
    );
    const [snapshot, itemPage] = await Promise.all([
      this.folderBrowser.browseFolderContents({
        folderId: params.folderId,
        sessionCursor: params.sessionCursor,
        sessionLimit: params.sessionLimit,
      }),
      this.folderBrowser.browse({
        folderId: params.folderId,
        cursor: params.cursor,
        limit: params.limit,
        includeArchived: params.includeArchived,
      }),
    ]);
    const boardItems = snapshot.boardItems;
    return {
      folderId: params.folderId,
      folder,
      childFolders,
      sessions: snapshot.sessions.items
        .filter((item): item is FolderSessionItem => item.type === "session")
        .map(toBrowseFolderSession),
      sessionsPage: snapshot.sessions.page,
      boardItems,
      items: itemPage.items,
      itemsPage: itemPage.page,
      counts: {
        childFolders: childFolders.length,
        sessions: snapshot.sessions.page.total,
        boardItems: boardItems.length,
        documents: boardItems.filter((item) => item.itemType === "markdown").length,
        assets: boardItems.filter((item) => item.itemType === "asset").length,
      },
    };
  }

  async searchFolderItems(
    params: Parameters<FolderBrowseService["search"]>[0],
  ): Promise<FolderBrowseResult> {
    return await this.folderBrowser.search(params);
  }

  async deleteFolder(folderId: string): Promise<void> {
    assertMutableFolder(folderId, "deleted");
    if (!this.folderService) throw new Error("folder service is required");
    const folder = await this.requireFolder(folderId);
    await this.folderService.setFolderArchived({
      actorKind: "system",
      actorSessionId: null,
      folderId,
      expectedVersion: folder.version,
      archived: true,
      idempotencyKey: randomUUID(),
    });
  }

  /**
   * 세션 다수를 폴더로 이동. folderId=null → 폴더 해제.
   *
   * Python `catalog_service.move_sessions_to_folder` L112-120 정합.
   */
  async moveSessionsToFolder(
    sessionIds: string[],
    folderId: string | null,
  ): Promise<void> {
    for (const sessionId of sessionIds) {
      await this.boardItems.moveSessionToFolder(sessionId, folderId);
    }
  }

  /**
   * 폴더 system prompt 조회 — settings.folderPrompt를 읽는다.
   *
   * Python `catalog_service.get_folder_system_prompt` 정합. 폴더 부재 시 throw.
   */
  async getFolderSystemPrompt(folderId: string): Promise<string | null> {
    const folder = await this.db.getFolderById(folderId);
    if (!folder) {
      throw new Error(`folder not found: ${folderId}`);
    }
    const settings = folder.settings;
    const prompt = settings.folderPrompt;
    return typeof prompt === "string" ? prompt : null;
  }

  /**
   * 폴더 system prompt 설정. prompt=null 또는 빈 문자열 → settings.folderPrompt 제거.
   *
   * Python `catalog_service.set_folder_system_prompt` 정합. folder_update stored proc로
   * settings 컬럼 전체 갱신 (기존 키 유지 + folderPrompt만 갱신).
   */
  async setFolderSystemPrompt(
    folderId: string,
    prompt: string | null,
  ): Promise<void> {
    const folder = await this.db.getFolderById(folderId);
    if (!folder) {
      throw new Error(`folder not found: ${folderId}`);
    }
    const settings: Record<string, unknown> = { ...folder.settings };
    if (prompt && prompt.trim().length > 0) {
      settings.folderPrompt = prompt;
    } else {
      delete settings.folderPrompt;
    }
    await this.renameFolderFields(folderId, { settings }, folder.version);
  }

  async setFolderParent(
    folderId: string,
    parentFolderId: string | null,
  ): Promise<void> {
    assertMutableFolder(folderId, "moved");
    await this.renameFolderFields(folderId, { parentFolderId });
  }

  /** 폴더 전체와 변경된 세션·보드 항목만 발행한다. */
  async broadcastCatalog(delta: CatalogMutationDelta = {}): Promise<void> {
    const sessionsDelta: CatalogSessionsDelta = {
      ...(delta.sessionsDelta ?? {}),
    };
    const sessionIds = (delta.sessionIds ?? []).filter(
      (sessionId) => !Object.prototype.hasOwnProperty.call(sessionsDelta, sessionId),
    );
    if (sessionIds.length > 0) {
      for (const session of await this.db.getSessionAssignmentsByIds(sessionIds)) {
        sessionsDelta[session.session_id] = sessionAssignmentFromRow(session);
      }
    }
    await this.broadcaster.emitCatalogUpdated({
      sessionsDelta,
      boardItemsDelta: boardItemsDelta(delta.boardItems, delta.deletedBoardItemIds),
    });
  }

  async updateBoardItemPosition(
    boardItemId: string,
    x: number,
    y: number,
  ): Promise<void> {
    await this.boardItems.updateBoardItemPosition(boardItemId, x, y);
  }

  async moveBoardItemToFolder(params: {
    boardItemId: string;
    folderId: string;
    position?: { x: number; y: number };
    idempotencyKey: string;
  }): Promise<CatalogBoardItemMoveResult> {
    return await this.boardItems.moveBoardItemToFolder(params);
  }

  async createMarkdownDocument(params: {
    folderId: string;
    title: string;
    body?: string;
    x?: number;
    y?: number;
  }): Promise<{
    document: MarkdownDocumentRow;
    boardItem: CatalogBoardItemRow;
  }> {
    return await this.boardItems.createMarkdownDocument(params);
  }

  async getMarkdownDocument(documentId: string) {
    return await this.boardItems.getMarkdownDocument(documentId);
  }

  async updateMarkdownDocument(
    documentId: string,
    fields: { title?: string; body?: string; expectedVersion: number },
  ) {
    return await this.boardItems.updateMarkdownDocument(documentId, fields);
  }

  async deleteMarkdownDocument(documentId: string): Promise<void> {
    await this.boardItems.deleteMarkdownDocument(documentId);
  }

  private async requireFolder(folderId: string) {
    const folder = await this.db.getFolderById(folderId);
    if (!folder) throw new Error(`folder not found: ${folderId}`);
    return folder;
  }

  private async renameFolderFields(
    folderId: string,
    fields: { name?: string; parentFolderId?: string | null; settings?: Record<string, unknown> },
    expectedVersion?: number,
  ): Promise<void> {
    if (!this.folderService) throw new Error("folder service is required");
    const version = expectedVersion ?? (await this.requireFolder(folderId)).version;
    await this.folderService.renameFolder({
      actorKind: "system",
      actorSessionId: null,
      folderId,
      expectedVersion: version,
      ...fields,
      idempotencyKey: randomUUID(),
    });
  }
}

function toBrowseFolderSession(row: FolderSessionItem): BrowseFolderSessionDto {
  return {
    sessionId: row.agentSessionId,
    title: row.displayName,
    displayName: row.displayName,
    status: row.status,
    sessionType: row.sessionType,
    createdAt: row.createdAt ?? row.updatedAt ?? "",
    updatedAt: row.updatedAt ?? row.createdAt ?? "",
    eventCount: row.eventCount,
    awaySummary: row.awaySummary,
    callerSessionId: row.callerSessionId,
    predecessorSessionId: row.predecessorSessionId,
    nodeId: row.nodeId,
    lastEventId: row.lastEventId,
    lastReadEventId: row.lastReadEventId,
  };
}

function assertMutableFolder(folderId: string, operation: string): void {
  if (folderId === "claude" || folderId === "llm") throw new Error(`System folder '${folderId}' cannot be ${operation}.`);
}
