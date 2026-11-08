import type { CatalogBoardItemRow, MarkdownDocumentRow, SessionDB } from "../db/session_db.js";
import type { FlatFolderContentHostClient } from "./flat_folder_content_host_client.js";

export interface CatalogBoardItemMoveResult {
  boardItem: CatalogBoardItemRow;
  enrolled: boolean;
}

export type CatalogFolderContentPort = Pick<FlatFolderContentHostClient,
  "moveBoardItemToFolder" | "createMarkdownDocument" | "updateMarkdownDocument" | "deleteMarkdownDocument">;

export class CatalogBoardItemService {
  constructor(private readonly db: SessionDB, private readonly host: CatalogFolderContentPort) {}

  async moveBoardItemToFolder(params: { boardItemId: string; folderId: string; idempotencyKey: string }): Promise<CatalogBoardItemMoveResult> {
    const boardItem = await this.host.moveBoardItemToFolder(params);
    return { boardItem, enrolled: false };
  }

  async createMarkdownDocument(params: { folderId: string; title: string; body?: string; x?: number; y?: number; documentId?: string }):
    Promise<{ document: MarkdownDocumentRow; boardItem: CatalogBoardItemRow }> {
    return await this.host.createMarkdownDocument({ folderId: params.folderId, title: params.title,
      body: params.body ?? "", documentId: params.documentId, x: params.x, y: params.y });
  }

  getMarkdownDocument(documentId: string): Promise<MarkdownDocumentRow | null> {
    return this.db.getMarkdownDocument(documentId);
  }

  async updateMarkdownDocument(documentId: string, fields: { title?: string; body?: string; expectedVersion: number }): Promise<MarkdownDocumentRow | null> {
    return await this.host.updateMarkdownDocument("", documentId, fields);
  }

  async deleteMarkdownDocument(documentId: string): Promise<void> {
    await this.host.deleteMarkdownDocument("", documentId);
  }
}
