/** Catalog projection broadcasts and worker board/document mutation facade. */


import type {
  CatalogBoardItemRow,
  MarkdownDocumentRow,
  SessionDB,
} from "../db/session_db.js";
import type { SessionBroadcaster } from "../upstream/session_broadcaster.js";
import {
  CatalogBoardItemService,
  type CatalogBoardItemMoveResult,
  type CatalogBoardYjsPort,
} from "./catalog_board_item_service.js";
import {
  boardItemsDelta,
  serializeCatalogFolders,
  sessionAssignmentFromRow,
  type CatalogMutationDelta,
  type CatalogSessionsDelta,
} from "./catalog_delta.js";

/** Emits catalog deltas after orch-owned mutations and lifecycle deletion. */
export class CatalogService {
  private readonly boardItems: CatalogBoardItemService;

  constructor(
    private readonly db: SessionDB,
    private readonly broadcaster: SessionBroadcaster,
    boardYjsService?: CatalogBoardYjsPort,
  ) {
    this.boardItems = new CatalogBoardItemService(
      db,
      boardYjsService,
      (delta) => this.broadcastCatalog(delta),
    );
  }

  /** Emits the catalog projection only after TaskLifecycleRoute owns deletion. */
  async broadcastSessionDeletion(
    sessionId: string,
    deletedBoardItemIds: string[],
  ): Promise<void> {
    await this.broadcastCatalog({
      sessionsDelta: { [sessionId]: null },
      deletedBoardItemIds,
    });
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
    await this.broadcaster.emitCatalogUpdated(
      serializeCatalogFolders(await this.db.getAllFolders()),
      sessionsDelta,
      boardItemsDelta(delta.boardItems, delta.deletedBoardItemIds),
    );
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

  async updateMarkdownDocument(
    documentId: string,
    fields: { title?: string; body?: string; expectedVersion: number },
  ) {
    return await this.boardItems.updateMarkdownDocument(documentId, fields);
  }

  async deleteMarkdownDocument(documentId: string): Promise<void> {
    await this.boardItems.deleteMarkdownDocument(documentId);
  }
}
