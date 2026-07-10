import type { IncomingMessage } from "node:http";

import { Hocuspocus } from "@hocuspocus/server";
import type { Extension, onAuthenticatePayload } from "@hocuspocus/server";
import type { FastifyBaseLogger } from "fastify";
import type WebSocket from "ws";
import * as Y from "yjs";

import {
  applyBoardYjsPosition,
  boardYjsFolderScope,
  createMarkdownYjsDocument,
  deleteBoardYjsItem,
  deleteMarkdownYjsDocument,
  deleteMovedBoardYjsItem,
  getBoardYjsContainerDocumentName,
  readMovableBoardYjsItem,
  updateMarkdownYjsDocument,
  upsertBoardYjsItem,
  upsertCustomViewYjsBoardItem,
  upsertMovedBoardYjsItem,
  upsertRunbookYjsBoardItem,
} from "./board_yjs_model.js";
import {
  authenticateBoardYjsConnection,
  type BoardYjsAuthConfig,
} from "./board_yjs_auth.js";
import {
  createBoardYjsPersistence,
  type BoardYjsPersistenceRepository,
} from "./board_yjs_persistence.js";
import type {
  BoardYjsContainerRef,
  CatalogBoardItemRow,
  MarkdownDocumentRow,
} from "./board_yjs_types.js";

export interface BoardYjsServiceConfig {
  repository: BoardYjsPersistenceRepository;
  auth: BoardYjsAuthConfig;
  logger: FastifyBaseLogger;
  hostMode: "node" | "orch";
}

export class BoardYjsService {
  private readonly hocuspocus: Hocuspocus | undefined;

  constructor(private readonly config: BoardYjsServiceConfig) {
    if (config.hostMode !== "orch") return;
    const persistence = createBoardYjsPersistence(config.repository);
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
    this.handleContainerConnection(socket, request, boardYjsFolderScope(folderId));
  }

  handleContainerConnection(
    socket: WebSocket,
    request: IncomingMessage,
    container: BoardYjsContainerRef,
  ): void {
    if (this.config.hostMode !== "orch") {
      this.config.logger.warn(
        { hostMode: this.config.hostMode, container },
        "rejected board Yjs websocket while orch hosting is disabled",
      );
      socket.close(1013, "board Yjs documents are hosted on orch");
      return;
    }
    this.requireHocuspocus().handleConnection(socket, request, {
      ...container,
      documentName: getBoardYjsContainerDocumentName(container),
    });
  }

  async close(): Promise<void> {
    if (!this.hocuspocus) return;
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
    } as const;
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
    sourceRunbookItemId?: string | null;
  }): Promise<CatalogBoardItemRow> {
    const boardItem: CatalogBoardItemRow = {
      id: `session:${input.sessionId}`,
      folderId: input.folderId,
      containerKind: input.container.containerKind,
      containerId: input.container.containerId,
      membershipKind: "primary",
      sourceRunbookItemId: input.sourceRunbookItemId ?? null,
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
        ...input.container,
      }, input)
    );
  }

  async removeRunbookBoardItem(folderId: string, boardItemId: string): Promise<void> {
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
    const hocuspocus = this.requireOrchHostMode();
    const sourceContainer = {
      containerKind: input.boardItem.containerKind ?? "folder",
      containerId: input.boardItem.containerId ?? input.boardItem.folderId,
    };
    const source = await hocuspocus.openDirectConnection(
      getBoardYjsContainerDocumentName(sourceContainer),
      { ...sourceContainer, source: "server" },
    );
    const targetContainer = {
      containerKind: input.targetScope.containerKind,
      containerId: input.targetScope.containerId,
    };
    let targetApplied = false;
    try {
      const moved = await readMovedItem(source, input.boardItem.id, input.targetScope, input.position);
      if (!moved) {
        const target = await hocuspocus.openDirectConnection(
          getBoardYjsContainerDocumentName(targetContainer),
          { ...targetContainer, source: "server" },
        );
        try {
          const existing = await readMovedItem(
            target,
            input.boardItem.id,
            input.targetScope,
            input.position,
          );
          if (existing) return existing.boardItem;
        } finally {
          await target.disconnect();
        }
        throw new Error(`board item not found in source Y.Doc: ${input.boardItem.id}`);
      }
      const target = await hocuspocus.openDirectConnection(
        getBoardYjsContainerDocumentName(targetContainer),
        { ...targetContainer, source: "server" },
      );
      try {
        await target.transact((document) => {
          upsertMovedBoardYjsItem(document as unknown as Y.Doc, moved);
        });
        targetApplied = true;
        await source.transact((document) => {
          deleteMovedBoardYjsItem(document as unknown as Y.Doc, moved);
        });
        return moved.boardItem;
      } catch (error) {
        if (targetApplied) {
          await target.transact((document) => {
            deleteMovedBoardYjsItem(document as unknown as Y.Doc, moved);
          });
        }
        throw error;
      } finally {
        await target.disconnect();
      }
    } finally {
      await source.disconnect();
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
    const hocuspocus = this.requireOrchHostMode();
    const resolved = typeof container === "string" ? boardYjsFolderScope(container) : container;
    const connection = await hocuspocus.openDirectConnection(
      getBoardYjsContainerDocumentName(resolved),
      { ...resolved, source: "server" },
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

  private requireOrchHostMode(): Hocuspocus {
    if (this.config.hostMode !== "orch") {
      throw new Error(
        "board Yjs direct document access is only allowed when BOARD_YJS_HOST_MODE=orch",
      );
    }
    return this.requireHocuspocus();
  }

  private requireHocuspocus(): Hocuspocus {
    if (!this.hocuspocus) throw new Error("board Yjs Hocuspocus service is not active");
    return this.hocuspocus;
  }
}

type DirectConnection = Awaited<ReturnType<Hocuspocus["openDirectConnection"]>>;

async function readMovedItem(
  connection: DirectConnection,
  boardItemId: string,
  targetScope: Parameters<typeof readMovableBoardYjsItem>[2],
  position?: { x: number; y: number },
): Promise<ReturnType<typeof readMovableBoardYjsItem>> {
  let result: ReturnType<typeof readMovableBoardYjsItem> = null;
  await connection.transact((document) => {
    result = readMovableBoardYjsItem(
      document as unknown as Y.Doc,
      boardItemId,
      targetScope,
      position,
    );
  });
  return result;
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
      return { user: result.subject };
    },
  };
}
