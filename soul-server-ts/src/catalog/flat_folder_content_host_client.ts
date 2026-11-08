import type { Logger } from "pino";
import { MarkdownDocumentVersionConflictError } from "../db/markdown_document_version.js";

import { PersistenceHostTransport, readOrchErrorEnvelope } from "../control_plane/persistence_host_transport.js";
import type { OrchProxyConfig } from "../mcp/runtime.js";
import type {
  CatalogBoardItemRow,
  CustomViewRow,
  ListFolderItemsParams,
  ListFolderItemsResult,
  MarkdownDocumentRow,
} from "../db/session_db.js";
import {
  CustomViewRevisionConflictError,
  type CustomViewProjectionHost,
  type CustomViewRecordMutationResult,
  type CustomViewWithBoardItem,
} from "../custom_view/custom_view_contract.js";

export interface FlatFolderContentHostClientConfig {
  orch: OrchProxyConfig;
  logger: Logger;
}

export class FlatFolderContentHostClient implements CustomViewProjectionHost {
  private readonly transport: PersistenceHostTransport;

  constructor(private readonly config: FlatFolderContentHostClientConfig) {
    this.transport = new PersistenceHostTransport(config);
  }

  async createMarkdownDocument(input: {
    folderId: string;
    title: string;
    body: string;
    x?: number;
    y?: number;
    documentId?: string;
  }): Promise<{ document: MarkdownDocumentRow; boardItem: CatalogBoardItemRow }> {
    return await this.request("create-markdown-document", input);
  }

  async moveSessionToFolder(
    sessionId: string,
    folderId: string | null,
  ): Promise<void> {
    await this.request("move-session-to-folder", { sessionId, folderId });
  }

  async moveBoardItemToFolder(input: { boardItemId: string; folderId: string; idempotencyKey: string }): Promise<CatalogBoardItemRow> {
    return await this.request("move-board-item-to-folder", input);
  }

  async upsertCustomViewBoardItem(input: {
    folderId: string;
    boardItemId: string;
    customViewId: string;
    title: string;
    html: string;
    revision: number;
    x: number;
    y: number;
    metadata?: Record<string, unknown>;
  }): Promise<CatalogBoardItemRow> {
    return await this.request("upsert-custom-view-board-item", input);
  }

  async removeBoardItem(folderId: string, boardItemId: string): Promise<void> {
    await this.request("remove-board-item", { folderId, boardItemId });
  }

  async updateMarkdownDocument(
    folderId: string,
    documentId: string,
    fields: { title?: string; body?: string; expectedVersion: number },
  ): Promise<MarkdownDocumentRow | null> {
    try {
      return await this.request("update-markdown-document", { documentId, fields });
    } catch (error) {
      if (error instanceof FlatFolderContentHostClientError && error.code === "MARKDOWN_DOCUMENT_VERSION_CONFLICT") {
        throw new MarkdownDocumentVersionConflictError(documentId, fields.expectedVersion,
          typeof error.details.actualVersion === "number" ? error.details.actualVersion : undefined);
      }
      throw error;
    }
  }

  async deleteMarkdownDocument(
    folderId: string,
    documentId: string,
  ): Promise<void> {
    await this.request("delete-markdown-document", {
      documentId,
    });
  }

  async getBoardItems(): Promise<CatalogBoardItemRow[]> {
    return await this.request("get-board-items", {});
  }

  async getBoardItemsByFolder(folderId: string): Promise<CatalogBoardItemRow[]> {
    return await this.request("get-board-items-by-folder", { folderId });
  }

  async getBoardItemById(boardItemId: string): Promise<CatalogBoardItemRow | null> {
    return await this.request("get-board-item", { boardItemId });
  }

  async getPrimarySessionBoardItem(
    sessionId: string,
  ): Promise<CatalogBoardItemRow | null> {
    return await this.request("get-primary-session-board-item", { sessionId });
  }

  async getMarkdownDocumentBoardItem(
    documentId: string,
  ): Promise<CatalogBoardItemRow | null> {
    return await this.request("get-markdown-document-board-item", { documentId });
  }

  async getBoardItemIdsForSession(sessionId: string): Promise<string[]> {
    return await this.request("get-board-item-ids-for-session", { sessionId });
  }

  async listFolderItems(
    params: ListFolderItemsParams,
  ): Promise<ListFolderItemsResult> {
    return await this.request("list-folder-items", params);
  }

  async getMarkdownDocument(documentId: string): Promise<MarkdownDocumentRow | null> {
    return await this.request("get-markdown-document", { documentId });
  }

  async getCustomView(customViewId: string): Promise<CustomViewWithBoardItem | null> {
    return await this.request("get-custom-view", { customViewId });
  }

  async listCustomViews(params: {
    folderId: string;
    includeArchived?: boolean;
    limit?: number;
  }): Promise<CustomViewWithBoardItem[]> {
    return await this.request("list-custom-views", params);
  }

  async createCustomViewRecord(input: {
    id: string;
    boardItemId: string;
    title: string;
    html: string;
    actorKind: CustomViewRow["createdActorKind"];
    actorSessionId: string | null;
    idempotencyKey: string;
  }): Promise<CustomViewRecordMutationResult> {
    return await this.request("create-custom-view-record", input);
  }

  async patchCustomViewRecord(input: {
    customViewId: string;
    boardItemId: string;
    expectedRevision: number;
    html: string;
    title?: string | null;
    actorKind: CustomViewRow["updatedActorKind"];
    actorSessionId: string | null;
    idempotencyKey: string;
  }): Promise<CustomViewRecordMutationResult> {
    try {
      return await this.request("patch-custom-view-record", input);
    } catch (error) {
      if (error instanceof FlatFolderContentHostClientError &&
        error.code === "CUSTOM_VIEW_REVISION_CONFLICT") {
        const actualRevision = Number(error.details.actualRevision);
        throw new CustomViewRevisionConflictError(
          input.customViewId,
          input.expectedRevision,
          Number.isFinite(actualRevision) ? actualRevision : input.expectedRevision,
        );
      }
      throw error;
    }
  }

  private async request<T>(operation: string, body: unknown): Promise<T> {
    const response = await this.transport.send(
      "POST",
      `/internal/folder-content/${encodeURIComponent(operation)}`,
      body,
    );
    if (!response.ok) {
      const detail = await readOrchErrorEnvelope(response);
      this.config.logger.warn(
        { operation, status: response.status, message: detail.message, code: detail.code },
        "folder content host request failed",
      );
      throw new FlatFolderContentHostClientError(
        detail.code,
        response.status,
        `folder content host ${operation} failed: ${detail.message}`,
        detail.details,
      );
    }
    return await response.json() as T;
  }
}

class FlatFolderContentHostClientError extends Error {
  constructor(
    readonly code: string | null,
    readonly status: number,
    message: string,
    readonly details: Record<string, unknown>,
  ) {
    super(message);
    this.name = "FlatFolderContentHostClientError";
  }
}
