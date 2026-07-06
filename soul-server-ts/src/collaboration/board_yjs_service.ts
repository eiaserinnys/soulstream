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
  deleteMarkdownYjsDocument,
  deleteBoardYjsItem,
  getBoardYjsContainerDocumentName,
  updateMarkdownYjsDocument,
  upsertRunbookYjsBoardItem,
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
    title: string;
    body: string;
    x: number;
    y: number;
    documentId: string;
  }): Promise<{ document: MarkdownDocumentRow; boardItem: CatalogBoardItemRow }> {
    return await this.withDirectConnection(input.folderId, (doc) =>
      createMarkdownYjsDocument(doc, input.folderId, input)
    );
  }

  async upsertRunbookBoardItem(input: {
    folderId: string;
    boardItemId: string;
    runbookId: string;
    title: string;
    x: number;
    y: number;
    metadata?: Record<string, unknown>;
  }): Promise<CatalogBoardItemRow> {
    return await this.withDirectConnection(input.folderId, (doc) =>
      upsertRunbookYjsBoardItem(doc, input)
    );
  }

  async removeRunbookBoardItem(
    folderId: string,
    boardItemId: string,
  ): Promise<void> {
    await this.withDirectConnection(folderId, (doc) => {
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
