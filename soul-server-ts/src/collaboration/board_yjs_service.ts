import type { IncomingMessage } from "node:http";

import { Hocuspocus } from "@hocuspocus/server";
import type { Extension, onAuthenticatePayload } from "@hocuspocus/server";
import type { FastifyBaseLogger } from "fastify";
import type WebSocket from "ws";
import * as Y from "yjs";

import type { CatalogBoardItemRow, MarkdownDocumentRow, SessionDB } from "../db/session_db.js";
import {
  applyBoardYjsPosition,
  createMarkdownYjsDocument,
  deleteMarkdownYjsDocument,
  getBoardYjsDocumentName,
  updateMarkdownYjsDocument,
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
    this.hocuspocus.handleConnection(socket, request, {
      folderId,
      documentName: getBoardYjsDocumentName(folderId),
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

  async updateBoardItemPosition(
    folderId: string,
    boardItemId: string,
    x: number,
    y: number,
  ): Promise<void> {
    await this.withDirectConnection(folderId, (doc) => {
      applyBoardYjsPosition(doc, boardItemId, { x, y });
      return true;
    });
  }

  async updateMarkdownDocument(
    folderId: string,
    documentId: string,
    fields: { title?: string; body?: string },
  ): Promise<MarkdownDocumentRow | null> {
    return await this.withDirectConnection(folderId, (doc) =>
      updateMarkdownYjsDocument(doc, documentId, fields)
    );
  }

  async deleteMarkdownDocument(
    folderId: string,
    documentId: string,
  ): Promise<void> {
    await this.withDirectConnection(folderId, (doc) => {
      deleteMarkdownYjsDocument(doc, documentId);
      return true;
    });
  }

  private async withDirectConnection<T>(
    folderId: string,
    callback: (doc: Y.Doc) => T,
  ): Promise<T> {
    const connection = await this.hocuspocus.openDirectConnection(
      getBoardYjsDocumentName(folderId),
      { folderId, source: "server" },
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
