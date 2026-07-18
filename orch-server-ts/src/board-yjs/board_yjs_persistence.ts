import { Database } from "@hocuspocus/extension-database";
import type {
  Extension,
  fetchPayload,
  onChangePayload,
  storePayload,
} from "@hocuspocus/server";
import * as Y from "yjs";

import {
  createBoardYDocSnapshot,
  parseBoardYjsDocumentName,
  readBoardYDocReplica,
} from "./board_yjs_model.js";
import type {
  BoardYjsContainerRef,
  BoardYjsContainerScope,
  BoardYjsReplica,
  BoardYjsSeed,
} from "./board_yjs_types.js";

export interface BoardYjsPersistenceRepository {
  getBoardYjsSnapshot(documentName: string): Promise<Uint8Array | null>;
  resolveBoardYjsContainerScope(
    container: BoardYjsContainerRef,
  ): Promise<BoardYjsContainerScope | null>;
  backfillTaskBoardItemsIntoSnapshot(
    documentName: string,
    container: BoardYjsContainerScope,
    snapshot: Uint8Array,
  ): Promise<Uint8Array>;
  loadBoardYjsSeed(container: BoardYjsContainerScope): Promise<BoardYjsSeed>;
  storeBoardYjsSnapshot(documentName: string, snapshot: Uint8Array): Promise<void>;
  markBoardYjsDocumentSynced(documentName: string): Promise<void>;
  appendBoardYjsUpdate(documentName: string, update: Uint8Array): Promise<void>;
  syncBoardYjsReplica(
    container: BoardYjsContainerScope,
    replica: BoardYjsReplica,
    documentName?: string,
  ): Promise<void>;
  invalidateBoardYjsCatalogCache?(container: BoardYjsContainerScope): void;
}

export interface BoardYjsPersistence {
  database: Database;
  updateLog: Extension;
}

export function createBoardYjsPersistence(
  repository: BoardYjsPersistenceRepository,
): BoardYjsPersistence {
  return {
    database: new Database({
      fetch: async (payload: fetchPayload) => {
        const snapshot = await repository.getBoardYjsSnapshot(payload.documentName);
        const container = parseBoardYjsDocumentName(payload.documentName);
        if (!container) return snapshot ?? null;
        const scope = await repository.resolveBoardYjsContainerScope(container);
        if (!scope) return snapshot ?? null;
        if (snapshot) {
          return await repository.backfillTaskBoardItemsIntoSnapshot(
            payload.documentName,
            scope,
            snapshot,
          );
        }
        const seed = await repository.loadBoardYjsSeed(scope);
        const encoded = createBoardYDocSnapshot({
          ...scope,
          boardItems: seed.boardItems,
          markdownDocuments: seed.markdownDocuments,
        });
        await repository.storeBoardYjsSnapshot(payload.documentName, encoded);
        await repository.markBoardYjsDocumentSynced(payload.documentName);
        return encoded;
      },
      store: async (payload: storePayload) => {
        await repository.storeBoardYjsSnapshot(payload.documentName, payload.state);
        const container = parseBoardYjsDocumentName(payload.documentName);
        if (!container) return;
        const scope = await repository.resolveBoardYjsContainerScope(container);
        if (!scope) return;
        const doc = new Y.Doc();
        Y.applyUpdate(doc, payload.state);
        await repository.syncBoardYjsReplica(
          scope,
          readBoardYDocReplica(scope, doc),
          payload.documentName,
        );
      },
    }),
    updateLog: {
      extensionName: "soulstream-board-yjs-update-log",
      async onChange(payload: onChangePayload) {
        await repository.appendBoardYjsUpdate(payload.documentName, payload.update);
        const container = parseBoardYjsDocumentName(payload.documentName);
        if (!container) return;
        const scope = await repository.resolveBoardYjsContainerScope(container);
        if (!scope) return;
        const snapshot = Y.encodeStateAsUpdate(payload.document);
        await repository.storeBoardYjsSnapshot(payload.documentName, snapshot);
        await repository.syncBoardYjsReplica(
          scope,
          readBoardYDocReplica(scope, payload.document),
          payload.documentName,
        );
        repository.invalidateBoardYjsCatalogCache?.(scope);
      },
    },
  };
}
