import { Database } from "@hocuspocus/extension-database";
import type { Extension, fetchPayload, storePayload, onChangePayload } from "@hocuspocus/server";
import * as Y from "yjs";

import type { SessionDB } from "../db/session_db.js";
import {
  createBoardYDocSnapshot,
  getFolderIdFromBoardYjsDocumentName,
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
        if (snapshot) return snapshot;

        const folderId = getFolderIdFromBoardYjsDocumentName(payload.documentName);
        if (!folderId) return null;
        const seed = await db.loadBoardYjsSeed(folderId);
        const encoded = createBoardYDocSnapshot({
          folderId,
          boardItems: seed.boardItems,
          markdownDocuments: seed.markdownDocuments,
        });
        await db.storeBoardYjsSnapshot(payload.documentName, encoded);
        return encoded;
      },
      store: async (payload: storePayload) => {
        await db.storeBoardYjsSnapshot(payload.documentName, payload.state);
        const folderId = getFolderIdFromBoardYjsDocumentName(payload.documentName);
        if (!folderId) return;
        const doc = new Y.Doc();
        Y.applyUpdate(doc, payload.state);
        await db.syncBoardYjsReplica(
          folderId,
          readBoardYDocReplica(folderId, doc),
        );
      },
    }),
    updateLog: {
      extensionName: "soulstream-board-yjs-update-log",
      async onChange(payload: onChangePayload) {
        await db.appendBoardYjsUpdate(payload.documentName, payload.update);
      },
    },
  };
}
