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
  getBoardYjsContainerDocumentName,
  readBoardYDocReplica,
  updateMarkdownYjsDocument,
  upsertBoardYjsItem,
  upsertCustomViewYjsBoardItem,
  upsertTaskYjsBoardItem,
} from "./board_yjs_model.js";
import {
  moveBoardItemBetweenDocuments,
  type BoardMoveInput,
  type StagedTaskBoardMove,
  withStagedTaskBoardMove,
} from "./board_yjs_move.js";
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
  moveTaskBoardItem?: (
    input: BoardMoveInput & { idempotencyKey: string },
  ) => Promise<CatalogBoardItemRow>;
}

export class BoardYjsService {
  private readonly hocuspocus: Hocuspocus | undefined;
  private readonly taskIdentityTails = new Map<string, Promise<void>>();

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

  /**
   * Stages a task board mutation off-document. The live Y.Doc is updated only
   * after the caller's database transaction commits successfully.
   */
  async withTaskBoardApplication<T>(input: {
    folderId: string;
    boardItemId: string;
    taskId: string;
    title: string;
    archived: boolean;
    x: number;
    y: number;
  }, persist: (application: {
    documentName: string;
    scope: {
      folderId: string;
      containerKind: "folder";
      containerId: string;
    };
    snapshot: Uint8Array;
    replica: ReturnType<typeof readBoardYDocReplica>;
  }) => Promise<T>): Promise<T> {
    return await this.withTaskIdentityLock(input.folderId, async () => {
      const hocuspocus = this.requireOrchHostMode();
      const scope = {
        folderId: input.folderId,
        containerKind: "folder" as const,
        containerId: input.folderId,
      };
      const documentName = getBoardYjsContainerDocumentName(scope);
      const connection = await hocuspocus.openDirectConnection(documentName, {
        ...scope,
        source: "task-identity",
      });
      try {
        const live = connection.document as unknown as Y.Doc | null;
        if (!live) throw new Error(`board Y.Doc direct connection closed: ${documentName}`);
        const staged = new Y.Doc();
        Y.applyUpdate(staged, Y.encodeStateAsUpdate(live));
        upsertTaskYjsBoardItem(staged, {
          folderId: input.folderId,
          boardItemId: input.boardItemId,
          taskId: input.taskId,
          title: input.title,
          x: input.x,
          y: input.y,
          metadata: { archived: input.archived },
        });
        const update = Y.encodeStateAsUpdate(staged, Y.encodeStateVector(live));
        const snapshot = Y.encodeStateAsUpdate(staged);
        const result = await persist({
          documentName,
          scope,
          snapshot,
          replica: readBoardYDocReplica(scope, staged),
        });
        await connection.transact((document) => {
          Y.applyUpdate(document as unknown as Y.Doc, update);
        });
        return result;
      } finally {
        await connection.disconnect();
      }
    });
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

  async removeTaskBoardItem(folderId: string, boardItemId: string): Promise<void> {
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
    idempotencyKey?: string;
  }): Promise<CatalogBoardItemRow> {
    if (input.boardItem.itemType === "task") {
      if (!input.idempotencyKey?.trim()) {
        throw new Error("task board move idempotencyKey is required");
      }
      if (!this.config.moveTaskBoardItem) {
        throw new Error("task identity move is not configured");
      }
      return await this.config.moveTaskBoardItem({
        ...input,
        idempotencyKey: input.idempotencyKey,
      });
    }
    return await moveBoardItemBetweenDocuments(this.requireOrchHostMode(), input);
  }

  async withTaskBoardMoveApplication(
    input: BoardMoveInput,
    persist: (application: StagedTaskBoardMove) => Promise<void>,
  ): Promise<CatalogBoardItemRow> {
    return await this.withTaskIdentityLock(input.boardItem.id, async () =>
      await withStagedTaskBoardMove(this.requireOrchHostMode(), input, persist)
    );
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

  private async withTaskIdentityLock<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.taskIdentityTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => gate, () => gate);
    this.taskIdentityTails.set(key, tail);
    await previous.catch(() => undefined);
    try {
      return await work();
    } finally {
      release();
      if (this.taskIdentityTails.get(key) === tail) this.taskIdentityTails.delete(key);
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
      return { user: result.subject };
    },
  };
}
