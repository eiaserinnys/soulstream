import { withFolderBoardIdentity, folderIdentityDocumentNames, type FolderBoardIdentityInput } from "./board_yjs_folder_identity.js";
import { upsertFolderYjsBoardItem } from "./board_yjs_model.js";
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
  nextBoardPosition,
  readBoardYDocReplica,
  updateMarkdownYjsDocument,
  upsertCustomViewYjsBoardItem,
} from "./board_yjs_model.js";
import { BoardYjsDocumentMutationGate } from "./board_yjs_document_mutation_gate.js";
import {
  type BoardMoveInput,
  boardMoveDocumentNames,
  type SessionBoardMoveInput,
  sessionBoardMoveDocumentNames,
  type StagedBoardMove,
  type StagedSessionBoardMove,
  withStagedBoardMove,
  withStagedSessionBoardMove,
} from "./board_yjs_move.js";
import {
  boardItemRemovalDocumentNames,
  withStagedBoardItemRemoval,
} from "./board_yjs_remove.js";
import {
  authenticateBoardYjsConnection,
  type BoardYjsAuthConfig,
} from "./board_yjs_auth.js";
import {
  createBoardYjsPersistence,
  type BoardYjsPersistenceRepository,
} from "./board_yjs_persistence.js";
import type {
  BoardYjsFolderScope,
  BoardYjsDocumentApplication,
  CatalogBoardItemRow,
  MarkdownDocumentRow,
} from "./board_yjs_types.js";

export interface BoardYjsServiceConfig {
  repository: BoardYjsPersistenceRepository;
  auth: BoardYjsAuthConfig;
  logger: FastifyBaseLogger;
  moveSessionBoardItem?: (input: {
    sessionId: string;
    targetScope: SessionBoardMoveInput["targetScope"];
    position?: { x: number; y: number };
    sourceChecklistItemId?: string | null;
  }) => Promise<CatalogBoardItemRow | null>;
  persistBoardItemMove?: (application: StagedBoardMove) => Promise<void>;
}

export class BoardYjsService {
  private readonly hocuspocus: Hocuspocus;
  private readonly boardIdentityTails = new Map<string, Promise<void>>();
  private readonly documentMutationGate = new BoardYjsDocumentMutationGate();

  constructor(private readonly config: BoardYjsServiceConfig) {
    const persistence = createBoardYjsPersistence(config.repository);
    this.hocuspocus = new Hocuspocus({
      name: "soulstream-board-yjs",
      quiet: true,
      debounce: 500,
      maxDebounce: 5_000,
      extensions: [
        createBoardYjsAuthExtension(config.auth, config.logger),
        persistence.snapshotSync,
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
    container: BoardYjsFolderScope,
  ): void {
    const documentName = getBoardYjsContainerDocumentName(container);
    this.requireHocuspocus().handleConnection(socket, request, {
      ...container,
      documentName,
    });
  }

  async close(): Promise<void> {
    await this.hocuspocus.hooks("onDestroy", { instance: this.hocuspocus });
    this.hocuspocus.closeConnections();
  }

  getStats(): { activeDocuments: number } {
    return { activeDocuments: this.hocuspocus?.getDocumentsCount() ?? 0 };
  }

  async createMarkdownDocument(input: {
    folderId: string;
    title: string;
    body: string;
    x?: number;
    y?: number;
    documentId: string;
  }): Promise<{ document: MarkdownDocumentRow; boardItem: CatalogBoardItemRow }> {
    const scope = {
      folderId: input.folderId,
    } as const;
    return await this.withDirectContainerConnection(scope, (doc) => {
      const [x, y] = input.x !== undefined && input.y !== undefined
        ? [input.x, input.y]
        : nextBoardPosition(readBoardYDocReplica(scope, doc).boardItems);
      return createMarkdownYjsDocument(doc, scope, { ...input, x, y });
    });
  }

  async upsertSessionBoardItem(input: {
    folderId: string;
    sessionId: string;
    x: number;
    y: number;
    sourceChecklistItemId?: string | null;
  }): Promise<CatalogBoardItemRow> {
    if (!this.config.moveSessionBoardItem) {
      throw new Error("session board move is not configured");
    }
    const moved = await this.config.moveSessionBoardItem({
      sessionId: input.sessionId,
      targetScope: {
        folderId: input.folderId,
      },
      position: { x: input.x, y: input.y },
      sourceChecklistItemId: input.sourceChecklistItemId ?? null,
    });
    if (!moved) throw new Error(`session board item was not created: ${input.sessionId}`);
    return moved;
  }

  async moveSessionToFolder(
    sessionId: string,
    folderId: string | null,
  ): Promise<CatalogBoardItemRow | null> {
    if (!this.config.moveSessionBoardItem) {
      throw new Error("session board move is not configured");
    }
    return await this.config.moveSessionBoardItem({
      sessionId,
      targetScope: folderId === null
        ? null
        : { folderId },
      sourceChecklistItemId: null,
    });
  }

  async withFolderBoardApplication<T>(input: FolderBoardIdentityInput,
    persist: (applications: BoardYjsDocumentApplication[]) => Promise<T>): Promise<T> {
    return this.withBoardIdentityLock(input.folderId, () =>
      this.documentMutationGate.withMutation(folderIdentityDocumentNames(input), () =>
        withFolderBoardIdentity(this.hocuspocus, input, persist)));
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
    return await this.withDirectContainerConnection({ folderId: input.folderId }, (doc) =>
      upsertCustomViewYjsBoardItem(doc, {
        folderId: input.folderId,
      }, input)
    );
  }

  async withBoardItemRemovalApplications<T>(
    boardItems: readonly CatalogBoardItemRow[],
    persist: (applications: readonly BoardYjsDocumentApplication[]) => Promise<T>,
  ): Promise<T> {
    return await this.documentMutationGate.withMutation(
      boardItemRemovalDocumentNames(boardItems),
      async () => await withStagedBoardItemRemoval(this.hocuspocus, boardItems, persist),
    );
  }

  async removeBoardItem(
    container: string | BoardYjsFolderScope,
    boardItemId: string,
  ): Promise<void> {
    await this.withDirectContainerConnection(container, (doc) => {
      deleteBoardYjsItem(doc, boardItemId);
      return true;
    });
  }

  async updateBoardItemPosition(
    container: string | BoardYjsFolderScope,
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
    };
    position?: { x: number; y: number };
    idempotencyKey?: string;
  }): Promise<CatalogBoardItemRow> {
    if (input.boardItem.itemType === "session") {
      if (!this.config.moveSessionBoardItem) {
        throw new Error("session board move is not configured");
      }
      const moved = await this.config.moveSessionBoardItem({
        sessionId: input.boardItem.itemId,
        targetScope: input.targetScope,
        ...(input.position ? { position: input.position } : {}),
        sourceChecklistItemId: input.boardItem.sourceChecklistItemId ?? null,
      });
      if (!moved) throw new Error(`session board item was not created: ${input.boardItem.itemId}`);
      return moved;
    }
    if (!this.config.persistBoardItemMove) {
      throw new Error("board item move persistence is not configured");
    }
    return await this.documentMutationGate.withMutation(boardMoveDocumentNames(input), async () =>
      await withStagedBoardMove(this.hocuspocus, input, this.config.persistBoardItemMove!)
    );
  }

  async withSessionBoardMoveApplications<T>(
    input: SessionBoardMoveInput,
    persist: (application: StagedSessionBoardMove) => Promise<T>,
  ): Promise<CatalogBoardItemRow | null> {
    return await this.withBoardIdentityLock(`session:${input.sessionId}`, async () => {
      const documentNames = sessionBoardMoveDocumentNames(input);
      const stage = async () => await withStagedSessionBoardMove(
        this.hocuspocus,
        input,
        async (application) => { await persist(application); },
      );
      return documentNames.length === 0
        ? await stage()
        : await this.documentMutationGate.withMutation(documentNames, stage);
    });
  }

  async updateMarkdownDocument(
    container: string | BoardYjsFolderScope,
    documentId: string,
    fields: { title?: string; body?: string; expectedVersion: number },
  ): Promise<MarkdownDocumentRow | null> {
    return await this.withDirectContainerConnection(container, (doc) =>
      updateMarkdownYjsDocument(doc, documentId, fields)
    );
  }

  async deleteMarkdownDocument(
    container: string | BoardYjsFolderScope,
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
    container: string | BoardYjsFolderScope,
    callback: (doc: Y.Doc) => T,
  ): Promise<T> {
    const resolved = typeof container === "string" ? boardYjsFolderScope(container) : container;
    const documentName = getBoardYjsContainerDocumentName(resolved);
    return await this.documentMutationGate.withMutation([documentName], async () => {
      const connection = await this.requireHocuspocus().openDirectConnection(
        documentName,
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
    });
  }

  private requireHocuspocus(): Hocuspocus {
    return this.hocuspocus;
  }

  private async withBoardIdentityLock<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.boardIdentityTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => gate, () => gate);
    this.boardIdentityTails.set(key, tail);
    await previous.catch(() => undefined);
    try {
      return await work();
    } finally {
      release();
      if (this.boardIdentityTails.get(key) === tail) this.boardIdentityTails.delete(key);
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
      const routedDocumentName = payload.context.documentName;
      if (routedDocumentName !== payload.documentName) {
        throw new Error(
          `Board Y.Doc protocol document ${payload.documentName} ` +
            `does not match routed document ${String(routedDocumentName)}`,
        );
      }
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
