import type { IncomingMessage } from "node:http";

import { Hocuspocus } from "@hocuspocus/server";
import type { Extension, onAuthenticatePayload } from "@hocuspocus/server";
import type { FastifyBaseLogger } from "fastify";
import type WebSocket from "ws";
import * as Y from "yjs";

import type {
  BoardYjsContainerRef,
  CatalogBoardItemRow,
  MarkdownDocumentRow,
  SessionDB,
} from "../db/session_db.js";
import {
  applyBoardYjsPosition,
  boardYjsFolderScope,
  createMarkdownYjsDocument,
  deleteMovedBoardYjsItem,
  deleteMarkdownYjsDocument,
  deleteBoardYjsItem,
  getBoardYjsContainerDocumentName,
  readMovableBoardYjsItem,
  updateMarkdownYjsDocument,
  upsertMovedBoardYjsItem,
  upsertBoardYjsItem,
  upsertCustomViewYjsBoardItem,
  upsertTaskYjsBoardItem,
} from "./board_yjs_model.js";
import {
  authenticateBoardYjsConnection,
  type BoardYjsAuthConfig,
} from "./board_yjs_auth.js";
import { createBoardYjsPersistence } from "./board_yjs_persistence.js";

export interface BoardYjsServiceConfig {
  db: SessionDB;
  auth: BoardYjsAuthConfig;
  logger: FastifyBaseLogger;
  nodeId: string;
  hostNodeId: string;
  isHost: boolean;
}

export class BoardYjsService {
  private readonly hocuspocus: Hocuspocus;

  constructor(private readonly config: BoardYjsServiceConfig) {
    const persistence = createBoardYjsPersistence(config.db);
    this.hocuspocus = new Hocuspocus({
      name: "soulstream-board-yjs",
      quiet: true,
      debounce: 500,
      maxDebounce: 5_000,
      extensions: [
        createBoardYjsAuthExtension(config.auth, config.logger),
        persistence.updateLog,
        persistence.database,
      ],
    });
  }

  handleConnection(
    socket: WebSocket,
    request: IncomingMessage,
    folderId: string,
  ): void {
    const scope = boardYjsFolderScope(folderId);
    this.handleContainerConnection(socket, request, scope);
  }

  handleContainerConnection(
    socket: WebSocket,
    request: IncomingMessage,
    container: BoardYjsContainerRef,
  ): void {
    if (!this.config.isHost) {
      this.config.logger.warn(
        {
          nodeId: this.config.nodeId,
          hostNodeId: this.config.hostNodeId,
          container,
        },
        "rejected non-host board Yjs websocket connection",
      );
      socket.close(1013, `board Yjs documents are hosted on ${this.config.hostNodeId}`);
      return;
    }
    this.hocuspocus.handleConnection(socket, request, {
      ...container,
      documentName: getBoardYjsContainerDocumentName(container),
    });
  }

  async close(): Promise<void> {
    await this.hocuspocus.hooks("onDestroy", { instance: this.hocuspocus });
    this.hocuspocus.closeConnections();
  }

  async createMarkdownDocument(input: {
    folderId: string;
    container?: BoardYjsContainerRef;
    title: string;
    body: string;
    x: number;
    y: number;
    documentId: string;
  }): Promise<{ document: MarkdownDocumentRow; boardItem: CatalogBoardItemRow }> {
    const scope = {
      folderId: input.folderId,
      containerKind: input.container?.containerKind ?? "folder",
      containerId: input.container?.containerId ?? input.folderId,
    };
    return await this.withDirectContainerConnection(scope, (doc) =>
      createMarkdownYjsDocument(doc, scope, input)
    );
  }

  async upsertSessionBoardItem(input: {
    folderId: string;
    container: BoardYjsContainerRef;
    sessionId: string;
    x: number;
    y: number;
    sourceTaskItemId?: string | null;
  }): Promise<CatalogBoardItemRow> {
    const boardItem: CatalogBoardItemRow = {
      id: `session:${input.sessionId}`,
      folderId: input.folderId,
      containerKind: input.container.containerKind,
      containerId: input.container.containerId,
      membershipKind: "primary",
      sourceTaskItemId: input.sourceTaskItemId ?? null,
      itemType: "session",
      itemId: input.sessionId,
      x: input.x,
      y: input.y,
      metadata: {},
    };
    await this.withDirectContainerConnection(input.container, (doc) => {
      upsertBoardYjsItem(doc, boardItem);
      return true;
    });
    return boardItem;
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
    return await this.withDirectConnection(input.folderId, (doc) =>
      upsertTaskYjsBoardItem(doc, input)
    );
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
    return await this.withDirectContainerConnection(input.container, (doc) =>
      upsertCustomViewYjsBoardItem(doc, {
        folderId: input.folderId,
        containerKind: input.container.containerKind,
        containerId: input.container.containerId,
      }, input)
    );
  }

  async removeTaskBoardItem(
    folderId: string,
    boardItemId: string,
  ): Promise<void> {
    await this.withDirectConnection(folderId, (doc) => {
      deleteBoardYjsItem(doc, boardItemId);
      return true;
    });
  }

  async removeBoardItem(
    container: string | BoardYjsContainerRef,
    boardItemId: string,
  ): Promise<void> {
    await this.withDirectContainerConnection(container, (doc) => {
      deleteBoardYjsItem(doc, boardItemId);
      return true;
    });
  }

  async updateBoardItemPosition(
    container: string | BoardYjsContainerRef,
    boardItemId: string,
    x: number,
    y: number,
  ): Promise<void> {
    await this.withDirectContainerConnection(container, (doc) => {
      applyBoardYjsPosition(doc, boardItemId, { x, y });
      return true;
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
  }): Promise<CatalogBoardItemRow> {
    this.assertHost();
    const sourceContainer = {
      containerKind: input.boardItem.containerKind ?? "folder",
      containerId: input.boardItem.containerId ?? input.boardItem.folderId,
    };
    const sourceConnection = await this.hocuspocus.openDirectConnection(
      getBoardYjsContainerDocumentName(sourceContainer),
      { ...sourceContainer, source: "server" },
    );
    let targetApplied = false;
    const targetContainer = {
      containerKind: input.targetScope.containerKind,
      containerId: input.targetScope.containerId,
    };
    try {
      const moved = await (async (): Promise<ReturnType<typeof readMovableBoardYjsItem>> => {
        let result: ReturnType<typeof readMovableBoardYjsItem> = null;
        await sourceConnection.transact((document) => {
          result = readMovableBoardYjsItem(
            document as unknown as Y.Doc,
            input.boardItem.id,
            input.targetScope,
            input.position,
          );
        });
        return result;
      })();
      if (!moved) {
        const targetConnection = await this.hocuspocus.openDirectConnection(
          getBoardYjsContainerDocumentName(targetContainer),
          { ...targetContainer, source: "server" },
        );
        try {
          const targetMoved = await (async (): Promise<ReturnType<typeof readMovableBoardYjsItem>> => {
            let result: ReturnType<typeof readMovableBoardYjsItem> = null;
            await targetConnection.transact((document) => {
              result = readMovableBoardYjsItem(
                document as unknown as Y.Doc,
                input.boardItem.id,
                input.targetScope,
                input.position,
              );
            });
            return result;
          })();
          if (targetMoved) return targetMoved.boardItem;
        } finally {
          await targetConnection.disconnect();
        }
        throw new Error(`board item not found in source Y.Doc: ${input.boardItem.id}`);
      }

      const targetConnection = await this.hocuspocus.openDirectConnection(
        getBoardYjsContainerDocumentName(targetContainer),
        { ...targetContainer, source: "server" },
      );
      try {
        await targetConnection.transact((document) => {
          upsertMovedBoardYjsItem(document as unknown as Y.Doc, moved);
        });
        targetApplied = true;
        await sourceConnection.transact((document) => {
          deleteMovedBoardYjsItem(document as unknown as Y.Doc, moved);
        });
        return moved.boardItem;
      } catch (err) {
        if (targetApplied) {
          await targetConnection.transact((document) => {
            deleteMovedBoardYjsItem(document as unknown as Y.Doc, moved);
          });
        }
        throw err;
      } finally {
        await targetConnection.disconnect();
      }
    } finally {
      await sourceConnection.disconnect();
    }
  }

  async updateMarkdownDocument(
    container: string | BoardYjsContainerRef,
    documentId: string,
    fields: { title?: string; body?: string; expectedVersion: number },
  ): Promise<MarkdownDocumentRow | null> {
    return await this.withDirectContainerConnection(container, (doc) =>
      updateMarkdownYjsDocument(doc, documentId, fields)
    );
  }

  async deleteMarkdownDocument(
    container: string | BoardYjsContainerRef,
    documentId: string,
  ): Promise<void> {
    await this.withDirectContainerConnection(container, (doc) => {
      deleteMarkdownYjsDocument(doc, documentId);
      return true;
    });
  }

  private async withDirectConnection<T>(
    folderId: string,
    callback: (doc: Y.Doc) => T,
  ): Promise<T> {
    return await this.withDirectContainerConnection(boardYjsFolderScope(folderId), callback);
  }

  private async withDirectContainerConnection<T>(
    container: string | BoardYjsContainerRef,
    callback: (doc: Y.Doc) => T,
  ): Promise<T> {
    this.assertHost();
    const resolvedContainer = typeof container === "string" ? boardYjsFolderScope(container) : container;
    const connection = await this.hocuspocus.openDirectConnection(
      getBoardYjsContainerDocumentName(resolvedContainer),
      { ...resolvedContainer, source: "server" },
    );
    try {
      let result: T | undefined;
      await connection.transact((document) => {
        result = callback(document as unknown as Y.Doc);
      });
      return result as T;
    } finally {
      await connection.disconnect();
    }
  }

  private assertHost(): void {
    if (this.config.isHost) return;
    throw new Error(
      `board Yjs direct document access is only allowed on host node ${this.config.hostNodeId} (current node ${this.config.nodeId})`,
    );
  }
}

function createBoardYjsAuthExtension(
  auth: BoardYjsAuthConfig,
  logger: FastifyBaseLogger,
): Extension {
  return {
    extensionName: "soulstream-board-yjs-auth",
    async onAuthenticate(payload: onAuthenticatePayload) {
      const result = await authenticateBoardYjsConnection({
        token: payload.token,
        requestHeaders: payload.requestHeaders,
        config: auth,
      });
      logger.debug(
        {
          documentName: payload.documentName,
          authSource: result.source,
          subject: result.subject,
        },
        "board Yjs websocket authenticated",
      );
      return {
        user: result.subject,
      };
    },
  };
}
