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
 * 본 PR은 stored procedure 호출만 — schema DDL 정본은 Python `sql/schema.sql`.
 */

import { randomUUID } from "node:crypto";

import type { SessionDB } from "../db/session_db.js";
import type { SessionBroadcaster } from "../upstream/session_broadcaster.js";

const BOARD_GRID_SIZE = 20;
const BOARD_TILE_WIDTH = 280;
const BOARD_TILE_HEIGHT = 160;
const BOARD_DEFAULT_COLUMNS = 4;

export interface CatalogFolderDto {
  id: string;
  name: string;
  sortOrder: number;
  settings: Record<string, unknown>;
  parentFolderId: string | null;
  createdAt?: string;
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
  constructor(
    private readonly db: SessionDB,
    private readonly broadcaster: SessionBroadcaster,
  ) {}

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
    await this.db.updateFolder(folderId, ["name"], [name]);
    await this.broadcastCatalog();
  }

  async deleteFolder(folderId: string): Promise<void> {
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
    await this.db.ensureBoardItems();
    await this.db.updateBoardItemPosition(
      boardItemId,
      snapBoardPosition(x),
      snapBoardPosition(y),
    );
    await this.broadcastCatalog();
  }

  async createMarkdownDocument(params: {
    folderId: string;
    title: string;
    body?: string;
    x?: number;
    y?: number;
  }): Promise<Awaited<ReturnType<SessionDB["createMarkdownDocument"]>>> {
    const documentId = randomUUID();
    const [x, y] = params.x !== undefined && params.y !== undefined
      ? [snapBoardPosition(params.x), snapBoardPosition(params.y)]
      : await this.nextBoardPosition(params.folderId);
    const result = await this.db.createMarkdownDocument({
      documentId,
      folderId: params.folderId,
      title: params.title,
      body: params.body ?? "",
      x,
      y,
    });
    await this.broadcastCatalog();
    return result;
  }

  async getMarkdownDocument(documentId: string) {
    return this.db.getMarkdownDocument(documentId);
  }

  async updateMarkdownDocument(
    documentId: string,
    fields: { title?: string; body?: string },
  ) {
    const document = await this.db.updateMarkdownDocument(documentId, fields);
    await this.broadcastCatalog();
    return document;
  }

  async deleteMarkdownDocument(documentId: string): Promise<void> {
    await this.db.deleteMarkdownDocument(documentId);
    await this.broadcastCatalog();
  }

  private async nextBoardPosition(folderId: string): Promise<[number, number]> {
    // Legacy REST/MCP markdown placement. Board catalog reads are Yjs-derived.
    await this.db.ensureBoardItems();
    const occupied = new Set(
      (await this.db.getBoardItems())
        .filter((item) => item.folderId === folderId)
        .map((item) => `${item.x}:${item.y}`),
    );
    let index = 0;
    while (true) {
      const x = (index % BOARD_DEFAULT_COLUMNS) * BOARD_TILE_WIDTH;
      const y = Math.floor(index / BOARD_DEFAULT_COLUMNS) * BOARD_TILE_HEIGHT;
      if (!occupied.has(`${x}:${y}`)) return [x, y];
      index += 1;
    }
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

function snapBoardPosition(value: number): number {
  return Math.round(value / BOARD_GRID_SIZE) * BOARD_GRID_SIZE;
}
