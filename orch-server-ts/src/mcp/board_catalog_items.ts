import type { CatalogBoardItemRow, MarkdownDocumentRow } from "../board/folder_content_types.js";
import type { BoardMcpStore } from "./board_catalog_types.js";

export interface CatalogFolderContentPort {
  moveSessionsToFolder(sessionIds: readonly string[], folderId: string | null): Promise<{ sessionIds: string[]; didCommit: boolean }>;
  createMarkdownDocument(input: { folderId: string; title: string; body: string; x?: number; y?: number; documentId?: string }):
    Promise<{ document: MarkdownDocumentRow; boardItem: CatalogBoardItemRow }>;
  updateMarkdownDocument(documentId: string, fields: { title?: string; body?: string; expectedVersion: number }): Promise<MarkdownDocumentRow | null>;
  deleteMarkdownDocument(documentId: string): Promise<void>;
}

export class CatalogBoardItemService {
  constructor(private readonly db: BoardMcpStore, private readonly host: CatalogFolderContentPort) {}

  async moveSessionsToFolder(sessionIds: readonly string[], folderId: string | null) {
    return await this.host.moveSessionsToFolder(sessionIds, folderId);
  }

  async createMarkdownDocument(params: { folderId: string; title: string; body?: string; x?: number; y?: number }) {
    return await this.host.createMarkdownDocument({ ...params, body: params.body ?? "" });
  }

  getMarkdownDocument(documentId: string): Promise<MarkdownDocumentRow | null> {
    return this.db.getMarkdownDocument(documentId);
  }

  async updateMarkdownDocument(documentId: string, fields: { title?: string; body?: string; expectedVersion: number }): Promise<MarkdownDocumentRow | null> {
    return await this.host.updateMarkdownDocument(documentId, fields);
  }

  async deleteMarkdownDocument(documentId: string): Promise<void> {
    await this.host.deleteMarkdownDocument(documentId);
  }
}
