/**
 * CatalogService — 폴더·세션 카탈로그 mutation 정본 (본 카드 신규).
 *
 * Python `packages/soul-common/src/soul_common/catalog/catalog_service.py` 키 호환 포팅.
 * MCP cogito 도구(`mcp_catalog.py`)와 dashboard 양쪽이 *같은 service*를 경유하여
 * 정책(broadcast 시점, ID 생성 책임)을 단일 자리에 둔다 (design-principles §3).
 *
 * 의존:
 *   - SessionDB — folders/sessions 테이블 mutation
 *   - SessionBroadcaster — catalog_updated / session_deleted wire emit
 *
 * 본 PR은 stored procedure 호출만 — schema DDL 정본은 `packages/db-schema/sql/schema.sql`.
 */

import { randomUUID } from "node:crypto";

import type { BoardYjsService } from "../collaboration/board_yjs_service.js";
import type {
  BoardYjsContainerRef,
  CatalogBoardItemRow,
  ListSessionSummaryRow,
  SessionDB,
} from "../db/session_db.js";
import { assertMutableFolder } from "../system_folders.js";
import type { SessionBroadcaster } from "../upstream/session_broadcaster.js";
import {
  CatalogBoardItemService,
  type CatalogBoardItemMoveResult,
} from "./catalog_board_item_service.js";

export interface CatalogFolderDto {
  id: string;
  name: string;
  sortOrder: number;
  settings: Record<string, unknown>;
  parentFolderId: string | null;
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
  counts: {
    childFolders: number;
    sessions: number;
    boardItems: number;
    documents: number;
    assets: number;
  };
}

/**
 * CatalogService — TaskManager·MCP 도구 양쪽 진입점이 공유.
 *
 * 본 클래스는 *broadcast 정책* 정본:
 *   - 폴더 CUD 후 → `broadcastCatalog()` 자동 호출 (대시보드 즉시 반영)
 *   - 세션 rename 후 → `broadcastCatalog()`
 *   - 세션 삭제 후 → `broadcastCatalog()` + `emitSessionDeleted()` (Python `delete_session`
 *     L135-141 정합)
 *
 * 도구·dashboard 진입점은 본 클래스를 호출하기만 한다 — broadcaster를 직접 호출하지 않는다.
 */
export class CatalogService {
  private readonly boardItems: CatalogBoardItemService;

  constructor(
    private readonly db: SessionDB,
    private readonly broadcaster: SessionBroadcaster,
    boardYjsService?: BoardYjsService,
  ) {
    this.boardItems = new CatalogBoardItemService(
      db,
      boardYjsService,
      () => this.broadcastCatalog(),
    );
  }

  async listFolders(): Promise<CatalogFolderDto[]> {
    const folders = await this.db.getAllFolders();
    return folders.map((f) => {
      const createdAt = f.created_at instanceof Date ? f.created_at.toISOString() : f.created_at;
      return {
        id: f.id,
        name: f.name,
        sortOrder: f.sort_order,
        settings: f.settings ?? {},
        parentFolderId: f.parent_folder_id,
        ...(createdAt ? { createdAt } : {}),
      };
    });
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
  }): Promise<BrowseFolderResult> {
    const cursor = Math.max(0, Math.trunc(params.sessionCursor ?? 0));
    const limit = Math.min(
      100,
      Math.max(1, Math.trunc(params.sessionLimit ?? 20)),
    );
    const catalog = await this.db.getCatalog();
    const folder = catalog.folders.find((candidate) => candidate.id === params.folderId);
    if (!folder) {
      throw new Error(`folder not found: ${params.folderId}`);
    }
    const childFolders = catalog.folders.filter(
      (candidate) => candidate.parentFolderId === params.folderId,
    );
    const boardItems = catalog.boardItems.filter(
      (item) => item.folderId === params.folderId,
    );
    const { sessions, total } = await this.db.listSessionsSummary({
      search: null,
      limit,
      offset: cursor,
      folderId: params.folderId,
      nodeId: null,
    });
    return {
      folderId: params.folderId,
      folder,
      childFolders,
      sessions: sessions.map(toBrowseFolderSession),
      sessionsPage: {
        cursor,
        limit,
        total,
        nextCursor: cursor + limit < total ? cursor + limit : null,
      },
      boardItems,
      counts: {
        childFolders: childFolders.length,
        sessions: total,
        boardItems: boardItems.length,
        documents: boardItems.filter((item) => item.itemType === "markdown").length,
        assets: boardItems.filter((item) => item.itemType === "asset").length,
      },
    };
  }

  /**
   * 새 폴더 생성. id는 randomUUID로 발급 (Python `folder_create`는 외부에서 id를 받음
   * — Python catalog_service.create_folder L63-68 정합).
   */
  async createFolder(
    name: string,
    sortOrder = 0,
    parentFolderId: string | null = null,
  ): Promise<CatalogFolderDto> {
    const id = randomUUID();
    await this.assertParentAllowed(id, parentFolderId);
    await this.db.createFolder(id, name, sortOrder, parentFolderId);
    await this.broadcastCatalog();
    return { id, name, sortOrder, settings: {}, parentFolderId };
  }

  async renameFolder(folderId: string, name: string): Promise<void> {
    assertMutableFolder(folderId, "renamed");
    await this.db.updateFolder(folderId, ["name"], [name]);
    await this.broadcastCatalog();
  }

  async deleteFolder(folderId: string): Promise<void> {
    assertMutableFolder(folderId, "deleted");
    await this.db.deleteFolderById(folderId);
    await this.broadcastCatalog();
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
      await this.db.assignSessionToFolder(sessionId, folderId);
    }
    await this.db.ensureBoardItems();
    await this.broadcastCatalog();
  }

  /**
   * 세션 표시 이름 갱신. displayName=null → 이름 제거.
   *
   * Python `catalog_service.rename_session` L126-133 정본:
   *   db.rename_session + broadcast_catalog().
   *
   * 정규화(trim·empty→null) 책임은 호출자 (도구 핸들러 또는 dashboard API).
   */
  async renameSession(
    sessionId: string,
    displayName: string | null,
  ): Promise<void> {
    await this.db.renameSession(sessionId, displayName);
    await this.broadcastCatalog();
  }

  /**
   * 세션 삭제 — 이벤트까지 함께 삭제 (schema.sql session_delete cascade).
   *
   * Python `catalog_service.delete_session` L135-141 정합:
   *   db.delete_session + broadcast_catalog() + emit_session_deleted.
   *
   * 두 wire를 모두 발사하는 이유:
   *   - catalog_updated → 폴더 트리 갱신
   *   - session_deleted → 세션 목록 행 즉시 제거
   */
  async deleteSession(sessionId: string): Promise<void> {
    await this.db.deleteSession(sessionId);
    await this.broadcastCatalog();
    await this.broadcaster.emitSessionDeleted(sessionId);
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
    await this.db.updateFolder(
      folderId,
      ["settings"],
      [JSON.stringify(settings)],
    );
    await this.broadcastCatalog();
  }

  async setFolderParent(
    folderId: string,
    parentFolderId: string | null,
  ): Promise<void> {
    assertMutableFolder(folderId, "moved");
    await this.assertParentAllowed(folderId, parentFolderId);
    await this.db.updateFolder(
      folderId,
      ["parent_folder_id"],
      [parentFolderId],
    );
    await this.broadcastCatalog();
  }

  /**
   * 카탈로그 wire 발사 — Python `catalog_service._broadcast_catalog` L39-47 정합.
   * 폴더 트리·세션 매핑을 한 번에 broadcast하여 대시보드가 일관된 스냅샷으로 갱신.
   */
  async broadcastCatalog(): Promise<void> {
    const catalog = await this.db.getCatalog();
    await this.broadcaster.emitCatalogUpdated(catalog);
  }

  async updateBoardItemPosition(
    boardItemId: string,
    x: number,
    y: number,
  ): Promise<void> {
    await this.boardItems.updateBoardItemPosition(boardItemId, x, y);
  }

  async moveBoardItemToContainer(params: {
    boardItemId: string;
    target: BoardYjsContainerRef;
    position?: { x: number; y: number };
    idempotencyKey: string;
  }): Promise<CatalogBoardItemMoveResult> {
    return await this.boardItems.moveBoardItemToContainer(params);
  }

  async createMarkdownDocument(params: {
    folderId: string;
    container?: BoardYjsContainerRef | null;
    title: string;
    body?: string;
    x?: number;
    y?: number;
  }): Promise<Awaited<ReturnType<SessionDB["createMarkdownDocument"]>>> {
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

  private async assertParentAllowed(
    folderId: string,
    parentFolderId: string | null,
  ): Promise<void> {
    if (parentFolderId === null) return;
    if (folderId === parentFolderId) {
      throw new Error("folder parent cycle");
    }
    const folders = await this.db.getAllFolders();
    const parentById = new Map(folders.map((folder) => [folder.id, folder.parent_folder_id]));
    let current: string | null | undefined = parentFolderId;
    const seen = new Set<string>();
    while (current) {
      if (current === folderId) {
        throw new Error("folder parent cycle");
      }
      if (seen.has(current)) {
        throw new Error("folder parent cycle");
      }
      seen.add(current);
      current = parentById.get(current);
    }
  }
}

function toBrowseFolderSession(row: ListSessionSummaryRow): BrowseFolderSessionDto {
  return {
    sessionId: row.session_id,
    title: row.display_name ?? row.session_id,
    displayName: row.display_name,
    status: row.status,
    sessionType: row.session_type,
    createdAt: serializeDate(row.created_at),
    updatedAt: serializeDate(row.updated_at),
    eventCount: row.event_count,
    awaySummary: row.away_summary,
    callerSessionId: row.caller_session_id,
    nodeId: row.node_id,
    lastEventId: row.last_event_id,
    lastReadEventId: row.last_read_event_id,
  };
}

function serializeDate(value: Date | string): string {
  if (value instanceof Date) return value.toISOString();
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : value;
}
