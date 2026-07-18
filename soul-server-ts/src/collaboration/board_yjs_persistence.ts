import { Database } from "@hocuspocus/extension-database";
import type { Extension, fetchPayload, storePayload, onChangePayload } from "@hocuspocus/server";
import * as Y from "yjs";

import type { SessionDB } from "../db/session_db.js";
import {
  createBoardYDocSnapshot,
  parseBoardYjsDocumentName,
  readBoardYDocReplica,
} from "./board_yjs_model.js";

export interface BoardYjsPersistence {
  database: Database;
  updateLog: Extension;
}

export function createBoardYjsPersistence(db: SessionDB): BoardYjsPersistence {
  return {
    database: new Database({
      fetch: async (payload: fetchPayload) => {
        const snapshot = await db.getBoardYjsSnapshot(payload.documentName);
        const container = parseBoardYjsDocumentName(payload.documentName);
        if (!container) return snapshot ?? null;
        const scope = await db.resolveBoardYjsContainerScope(container);
        if (!scope) return snapshot ?? null;
        if (snapshot) {
          return await db.backfillTaskBoardItemsIntoBoardYjsSnapshot(
            payload.documentName,
            scope,
            snapshot,
          );
        }

        const seed = await db.loadBoardYjsSeed(scope);
        const encoded = createBoardYDocSnapshot({
          folderId: scope.folderId,
          containerKind: scope.containerKind,
          containerId: scope.containerId,
          boardItems: seed.boardItems,
          markdownDocuments: seed.markdownDocuments,
        });
        await db.storeBoardYjsSnapshot(payload.documentName, encoded);
        await db.markBoardYjsDocumentSynced(payload.documentName);
        return encoded;
      },
      store: async (payload: storePayload) => {
        await db.storeBoardYjsSnapshot(payload.documentName, payload.state);
        const container = parseBoardYjsDocumentName(payload.documentName);
        if (!container) return;
        const scope = await db.resolveBoardYjsContainerScope(container);
        if (!scope) return;
        const doc = new Y.Doc();
        Y.applyUpdate(doc, payload.state);
        await db.syncBoardYjsReplica(
          scope,
          readBoardYDocReplica(scope, doc),
          payload.documentName,
        );
      },
    }),
    updateLog: {
      extensionName: "soulstream-board-yjs-update-log",
      async onChange(payload: onChangePayload) {
        await db.appendBoardYjsUpdate(payload.documentName, payload.update);
        const container = parseBoardYjsDocumentName(payload.documentName);
        if (!container) return;
        const scope = await db.resolveBoardYjsContainerScope(container);
        if (!scope) return;
        const snapshot = Y.encodeStateAsUpdate(payload.document);
        await db.storeBoardYjsSnapshot(payload.documentName, snapshot);
        await db.syncBoardYjsReplica(
          scope,
          readBoardYDocReplica(scope, payload.document),
          payload.documentName,
        );
        db.invalidateBoardYjsCatalogCache(scope);
      },
    },
  };
}
