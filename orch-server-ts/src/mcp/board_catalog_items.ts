import { randomUUID } from "node:crypto";

import { nextBoardPosition as firstAvailableBoardPosition, getMarkdownPreview } from "../board-yjs/board_yjs_model.js";
import type { CatalogBoardItemRow, MarkdownDocumentRow } from "../board-yjs/board_yjs_types.js";
import type { BoardMcpStore } from "./board_catalog_types.js";
import type { CatalogMutationDelta } from "./board_catalog_delta.js";

const BOARD_GRID_SIZE = 20;

export interface CatalogBoardItemMoveResult {
  boardItem: CatalogBoardItemRow;
  enrolled: boolean;
}

export interface CatalogBoardYjsPort {
  moveSessionToFolder(sessionId: string, folderId: string | null): Promise<CatalogBoardItemRow | null>;
  updateBoardItemPosition(folderId: string, boardItemId: string, x: number, y: number): Promise<void>;
  moveBoardItemToFolder(input: {
    boardItem: CatalogBoardItemRow;
    targetFolderId: string;
    position?: { x: number; y: number };
    idempotencyKey: string;
  }): Promise<CatalogBoardItemRow>;
  createMarkdownDocument(input: {
    folderId: string;
    title: string;
    body: string;
    x: number;
    y: number;
    documentId: string;
  }): Promise<{ document: MarkdownDocumentRow; boardItem: CatalogBoardItemRow }>;
  updateMarkdownDocument(folderId: string, documentId: string, fields: {
    title?: string; body?: string; expectedVersion: number;
  }): Promise<MarkdownDocumentRow | null>;
  deleteMarkdownDocument(folderId: string, documentId: string): Promise<void>;
  upsertSessionBoardItem(input: {
    folderId: string;
    sessionId: string;
    x: number;
    y: number;
  }): Promise<CatalogBoardItemRow>;
}

export class CatalogBoardItemService {
  constructor(
    private readonly db: BoardMcpStore,
    private readonly boardYjsService: CatalogBoardYjsPort | undefined,
    private readonly broadcastCatalog: (delta?: CatalogMutationDelta) => Promise<void>,
  ) {}

  async moveSessionToFolder(sessionId: string, folderId: string | null): Promise<CatalogBoardItemRow | null> {
    return await this.requireBoard().moveSessionToFolder(sessionId, folderId);
  }

  async updateBoardItemPosition(boardItemId: string, x: number, y: number): Promise<void> {
    const snappedX = snapBoardPosition(x);
    const snappedY = snapBoardPosition(y);
    const boardItem = await this.db.getBoardItemById(boardItemId);
    if (!boardItem) throw new Error(`board item not found: ${boardItemId}`);
    if (boardItem.x === snappedX && boardItem.y === snappedY) return;
    await this.requireBoard().updateBoardItemPosition(boardItem.folderId, boardItemId, snappedX, snappedY);
    await this.broadcastCatalog({ boardItems: [{ ...boardItem, x: snappedX, y: snappedY }] });
  }

  async moveBoardItemToFolder(params: {
    boardItemId: string;
    folderId: string;
    position?: { x: number; y: number };
    idempotencyKey: string;
  }): Promise<CatalogBoardItemMoveResult> {
    if (!params.boardItemId.trim()) throw new Error("boardItemId is required");
    if (!await this.db.getFolderById(params.folderId)) {
      throw new Error(`folder not found: ${params.folderId}`);
    }
    const position = params.position && {
      x: snapBoardPosition(params.position.x),
      y: snapBoardPosition(params.position.y),
    };
    const boardItem = await this.db.getBoardItemById(params.boardItemId);
    if (!boardItem) {
      const enrolled = await this.enrollGeneratedSessionBoardItem(params.boardItemId, params.folderId, position);
      if (!enrolled) throw new Error(`board item not found: ${params.boardItemId}`);
      return { boardItem: enrolled, enrolled: true };
    }
    if ((boardItem.membershipKind ?? "primary") !== "primary") {
      throw new Error("only primary board item membership can be moved");
    }
    if (!isMovableBoardItemType(boardItem.itemType)) {
      throw new Error(`board item type is not movable: ${boardItem.itemType}`);
    }
    if (boardItem.folderId === params.folderId) {
      if (position) {
        await this.updateBoardItemPosition(boardItem.id, position.x, position.y);
        return { boardItem: { ...boardItem, ...position }, enrolled: false };
      }
      return { boardItem, enrolled: false };
    }
    const moved = await this.requireBoard().moveBoardItemToFolder({
      boardItem,
      targetFolderId: params.folderId,
      ...(position ? { position } : {}),
      idempotencyKey: params.idempotencyKey,
    });
    if (moved.itemType !== "session") {
      await this.broadcastCatalog({ boardItems: [moved] });
    }
    return { boardItem: moved, enrolled: false };
  }

  async createMarkdownDocument(params: {
    folderId: string;
    title: string;
    body?: string;
    x?: number;
    y?: number;
  }): Promise<{ document: MarkdownDocumentRow; boardItem: CatalogBoardItemRow }> {
    const documentId = randomUUID();
    const [x, y] = params.x !== undefined && params.y !== undefined
      ? [snapBoardPosition(params.x), snapBoardPosition(params.y)]
      : await this.nextBoardPosition(params.folderId);
    const result = await this.requireBoard().createMarkdownDocument({
      documentId,
      folderId: params.folderId,
      title: params.title,
      body: params.body ?? "",
      x,
      y,
    });
    await this.broadcastCatalog({ boardItems: [result.boardItem] });
    return result;
  }

  getMarkdownDocument(documentId: string): Promise<MarkdownDocumentRow | null> {
    return this.db.getMarkdownDocument(documentId);
  }

  async updateMarkdownDocument(documentId: string, fields: {
    title?: string; body?: string; expectedVersion: number;
  }): Promise<MarkdownDocumentRow | null> {
    if (fields.title === undefined && fields.body === undefined) return this.getMarkdownDocument(documentId);
    const boardItem = await this.db.getMarkdownDocumentBoardItem(documentId);
    if (!boardItem) {
      if (await this.db.getMarkdownDocument(documentId)) {
        throw new Error(`markdown document board item not found: ${documentId}`);
      }
      return null;
    }
    const document = await this.requireBoard().updateMarkdownDocument(boardItem.folderId, documentId, fields);
    await this.broadcastCatalog({
      boardItems: document ? [{
        ...boardItem,
        metadata: {
          ...boardItem.metadata,
          title: document.title,
          preview: getMarkdownPreview(document.body),
          version: document.version,
        },
      }] : [],
    });
    return document;
  }

  async deleteMarkdownDocument(documentId: string): Promise<void> {
    const boardItem = await this.db.getMarkdownDocumentBoardItem(documentId);
    if (!boardItem) {
      if (await this.db.getMarkdownDocument(documentId)) {
        throw new Error(`markdown document board item not found: ${documentId}`);
      }
      return;
    }
    await this.requireBoard().deleteMarkdownDocument(boardItem.folderId, documentId);
    await this.broadcastCatalog({ deletedBoardItemIds: [boardItem.id] });
  }

  private requireBoard(): CatalogBoardYjsPort {
    if (!this.boardYjsService) throw new Error("orchestrator Board Yjs mutation port is not configured");
    return this.boardYjsService;
  }

  private async nextBoardPosition(folderId: string): Promise<[number, number]> {
    return firstAvailableBoardPosition(await this.db.getBoardItemsByFolder(folderId));
  }

  private async enrollGeneratedSessionBoardItem(
    boardItemId: string,
    folderId: string,
    position?: { x: number; y: number },
  ): Promise<CatalogBoardItemRow | null> {
    if (!boardItemId.startsWith("session:")) return null;
    const sessionId = boardItemId.slice("session:".length);
    if (!sessionId.trim()) return null;
    const session = await this.db.getSession(sessionId);
    if (session?.folder_id !== folderId) return null;
    const [x, y] = position ? [position.x, position.y] : await this.nextBoardPosition(folderId);
    return await this.requireBoard().upsertSessionBoardItem({
      folderId,
      sessionId,
      x,
      y,
    });
  }
}

function snapBoardPosition(value: number): number {
  return Math.round(value / BOARD_GRID_SIZE) * BOARD_GRID_SIZE;
}

function isMovableBoardItemType(itemType: CatalogBoardItemRow["itemType"]): boolean {
  return itemType === "session" || itemType === "markdown" ||
    itemType === "asset" || itemType === "custom_view" || itemType === "subfolder";
}
