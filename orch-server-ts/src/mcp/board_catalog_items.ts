import { randomUUID } from "node:crypto";

import { nextBoardPosition as firstAvailableBoardPosition, getMarkdownPreview } from "../board-yjs/board_yjs_model.js";
import type { CatalogBoardItemRow, MarkdownDocumentRow } from "../board-yjs/board_yjs_types.js";
import type { BoardMcpStore } from "./board_catalog_types.js";
import type { CatalogMutationDelta } from "./board_catalog_delta.js";

const BOARD_GRID_SIZE = 20;

export interface CatalogBoardYjsPort {
  moveSessionToFolder(sessionId: string, folderId: string | null): Promise<CatalogBoardItemRow | null>;
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
}

function snapBoardPosition(value: number): number {
  return Math.round(value / BOARD_GRID_SIZE) * BOARD_GRID_SIZE;
}
