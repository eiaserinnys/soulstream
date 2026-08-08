import type { Logger } from "pino";

import type { OrchProxyConfig } from "../mcp/runtime.js";
import type {
  BoardYjsContainerRef,
  BoardYjsContainerScope,
  CatalogBoardItemRow,
  CustomViewRow,
  ListContainerItemsParams,
  ListContainerItemsResult,
  MarkdownDocumentRow,
} from "../db/session_db.js";
import type {
  ChecklistProjectionOutboxRow,
  ChecklistTaskProjectionRepository,
} from "../page/checklist_task_projection_repository.js";
import {
  CustomViewRevisionConflictError,
  type CustomViewProjectionHost,
  type CustomViewRecordMutationResult,
  type CustomViewWithBoardItem,
} from "../custom_view/custom_view_contract.js";

export interface BoardYjsHostClientConfig {
  orch: OrchProxyConfig;
  logger: Logger;
}

export class BoardYjsHostClient
  implements ChecklistTaskProjectionRepository, CustomViewProjectionHost {
  constructor(private readonly config: BoardYjsHostClientConfig) {}

  async createMarkdownDocument(input: {
    folderId: string;
    container?: BoardYjsContainerRef;
    title: string;
    body: string;
    x: number;
    y: number;
    documentId: string;
  }): Promise<{ document: MarkdownDocumentRow; boardItem: CatalogBoardItemRow }> {
    return await this.request("create-markdown-document", input);
  }

  async upsertSessionBoardItem(input: {
    folderId: string;
    container: BoardYjsContainerRef;
    sessionId: string;
    x: number;
    y: number;
    sourceTaskItemId?: string | null;
  }): Promise<CatalogBoardItemRow> {
    return await this.request("upsert-session-board-item", input);
  }

  async moveSessionToFolder(
    sessionId: string,
    folderId: string | null,
  ): Promise<CatalogBoardItemRow | null> {
    return await this.request("move-session-to-folder", { sessionId, folderId });
  }

  async upsertTaskBoardItem(input: {
    folderId: string;
    boardItemId: string;
    taskId: string;
    title: string;
    x: number;
    y: number;
    metadata?: Record<string, unknown>;
  }): Promise<CatalogBoardItemRow> {
    return await this.request("upsert-task-board-item", input);
  }

  async upsertCustomViewBoardItem(input: {
    folderId: string;
    container: BoardYjsContainerRef;
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

  async removeTaskBoardItem(folderId: string, boardItemId: string): Promise<void> {
    await this.request("remove-task-board-item", { folderId, boardItemId });
  }

  async removeBoardItem(
    container: string | BoardYjsContainerRef,
    boardItemId: string,
  ): Promise<void> {
    await this.request("remove-board-item", {
      container: normalizeContainer(container),
      boardItemId,
    });
  }

  async updateBoardItemPosition(
    container: string | BoardYjsContainerRef,
    boardItemId: string,
    x: number,
    y: number,
  ): Promise<void> {
    await this.request("update-board-item-position", {
      container: normalizeContainer(container),
      boardItemId,
      x,
      y,
    });
  }

  async moveBoardItemToContainer(input: {
    boardItem: CatalogBoardItemRow;
    targetScope: {
      folderId: string;
      containerKind: BoardYjsContainerRef["containerKind"];
      containerId: string;
    };
    position?: { x: number; y: number };
    idempotencyKey: string;
  }): Promise<CatalogBoardItemRow> {
    return await this.request("move-board-item-to-container", input);
  }

  async updateMarkdownDocument(
    container: string | BoardYjsContainerRef,
    documentId: string,
    fields: { title?: string; body?: string; expectedVersion: number },
  ): Promise<MarkdownDocumentRow | null> {
    return await this.request("update-markdown-document", {
      container: normalizeContainer(container),
      documentId,
      fields,
    });
  }

  async deleteMarkdownDocument(
    container: string | BoardYjsContainerRef,
    documentId: string,
  ): Promise<void> {
    await this.request("delete-markdown-document", {
      container: normalizeContainer(container),
      documentId,
    });
  }

  async getBoardItems(): Promise<CatalogBoardItemRow[]> {
    return await this.request("get-board-items", {});
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

  async listContainerItems(
    params: ListContainerItemsParams,
  ): Promise<ListContainerItemsResult> {
    return await this.request("list-container-items", params);
  }

  async resolveBoardYjsContainerScope(
    container: string | BoardYjsContainerRef,
  ): Promise<BoardYjsContainerScope | null> {
    return await this.request("resolve-board-yjs-container-scope", {
      container: normalizeContainer(container),
    });
  }

  async getMarkdownDocument(documentId: string): Promise<MarkdownDocumentRow | null> {
    return await this.request("get-markdown-document", { documentId });
  }

  async getCustomView(customViewId: string): Promise<CustomViewWithBoardItem | null> {
    return await this.request("get-custom-view", { customViewId });
  }

  async listCustomViews(params: {
    container: BoardYjsContainerRef;
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
      if (error instanceof BoardYjsHostClientError &&
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

  async claimDue(
    nodeId: string,
    limit = 20,
    leaseMs = 30_000,
  ): Promise<ChecklistProjectionOutboxRow[]> {
    return await this.request("claim-checklist-task-projections", {
      nodeId,
      limit,
      leaseMs,
    });
  }

  async markSuccess(
    row: ChecklistProjectionOutboxRow,
    nodeId: string,
  ): Promise<boolean> {
    return await this.request("mark-checklist-task-projection-success", { row, nodeId });
  }

  async markFailure(
    row: ChecklistProjectionOutboxRow,
    nodeId: string,
    error: string,
  ): Promise<void> {
    await this.request("mark-checklist-task-projection-failure", { row, nodeId, error });
  }

  private async request<T>(operation: string, body: unknown): Promise<T> {
    const url = `${this.config.orch.baseUrl}/api/board-yjs/host/${encodeURIComponent(operation)}`;
    const headers = {
      ...this.config.orch.headers,
      "content-type": "application/json",
    };
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const detail = await responseErrorDetail(response);
      this.config.logger.warn(
        { operation, status: response.status, message: detail.message, code: detail.code },
        "board Yjs host proxy request failed",
      );
      throw new BoardYjsHostClientError(
        detail.code,
        response.status,
        `board Yjs host proxy ${operation} failed: ${detail.message}`,
        detail.details,
      );
    }
    return await response.json() as T;
  }
}

function normalizeContainer(container: string | BoardYjsContainerRef): BoardYjsContainerRef {
  if (typeof container === "string") {
    return { containerKind: "folder", containerId: container };
  }
  return container;
}

class BoardYjsHostClientError extends Error {
  constructor(
    readonly code: string | null,
    readonly status: number,
    message: string,
    readonly details: Record<string, unknown>,
  ) {
    super(message);
    this.name = "BoardYjsHostClientError";
  }
}

async function responseErrorDetail(response: Response): Promise<{
  message: string;
  code: string | null;
  details: Record<string, unknown>;
}> {
  const text = await response.text();
  if (!text) {
    return {
      message: `${response.status} ${response.statusText}`,
      code: null,
      details: {},
    };
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object") {
      const detail = (parsed as { detail?: unknown }).detail;
      if (typeof detail === "string") {
        return { message: detail, code: null, details: {} };
      }
      if (detail && typeof detail === "object") {
        const error = (detail as { error?: unknown }).error;
        if (error && typeof error === "object") {
          const record = error as Record<string, unknown>;
          const message = typeof record.message === "string" ? record.message : text;
          const code = typeof record.code === "string" ? record.code : null;
          return { message, code, details: record };
        }
      }
    }
  } catch {
    return { message: text, code: null, details: {} };
  }
  return { message: text, code: null, details: {} };
}
