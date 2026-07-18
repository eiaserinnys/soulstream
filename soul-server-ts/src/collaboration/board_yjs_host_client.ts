import type { Logger } from "pino";

import type { OrchProxyConfig } from "../mcp/runtime.js";
import type {
  BoardYjsContainerRef,
  CatalogBoardItemRow,
  MarkdownDocumentRow,
} from "../db/session_db.js";

export interface BoardYjsHostClientConfig {
  orch: OrchProxyConfig;
  logger: Logger;
}

export class BoardYjsHostClient {
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
      const message = await responseErrorMessage(response);
      this.config.logger.warn(
        { operation, status: response.status, message },
        "board Yjs host proxy request failed",
      );
      throw new Error(`board Yjs host proxy ${operation} failed: ${message}`);
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

async function responseErrorMessage(response: Response): Promise<string> {
  const text = await response.text();
  if (!text) return `${response.status} ${response.statusText}`;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object") {
      const detail = (parsed as { detail?: unknown }).detail;
      if (typeof detail === "string") return detail;
      if (detail && typeof detail === "object") {
        const error = (detail as { error?: unknown }).error;
        if (error && typeof error === "object") {
          const message = (error as { message?: unknown }).message;
          if (typeof message === "string") return message;
        }
      }
    }
  } catch {
    return text;
  }
  return text;
}
