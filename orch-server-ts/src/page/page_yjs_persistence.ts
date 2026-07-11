import { Database } from "@hocuspocus/extension-database";
import type {
  Extension,
  fetchPayload,
  onChangePayload,
  storePayload,
} from "@hocuspocus/server";
import * as Y from "yjs";

import {
  parsePageYjsDocumentName,
  readPageYDocReplica,
  type PageYjsReplica,
} from "./page_yjs_model.js";

export interface StorePageYjsStateInput {
  documentName: string;
  snapshot: Uint8Array;
  update?: Uint8Array;
  replica: PageYjsReplica;
}

export interface PageYjsPersistenceRepository {
  getPageYjsSnapshot(documentName: string): Promise<Uint8Array | null>;
  storePageYjsState(input: StorePageYjsStateInput): Promise<void>;
}

export interface PageYjsPersistence {
  database: Database;
  updateLog: Extension;
}

export class PageYjsSnapshotMissingError extends Error {
  readonly code = "PAGE_YJS_SNAPSHOT_MISSING";

  constructor(readonly pageId: string) {
    super(`PAGE_YJS_SNAPSHOT_MISSING: ${pageId}`);
    this.name = "PageYjsSnapshotMissingError";
  }
}

export function createPageYjsPersistence(
  repository: PageYjsPersistenceRepository,
): PageYjsPersistence {
  return {
    database: new Database({
      fetch: async (payload: fetchPayload) => {
        const pageId = requirePageDocumentName(payload.documentName);
        const snapshot = await repository.getPageYjsSnapshot(payload.documentName);
        if (!snapshot) throw new PageYjsSnapshotMissingError(pageId);
        return snapshot;
      },
      store: async (payload: storePayload) => {
        const pageId = requirePageDocumentName(payload.documentName);
        const doc = new Y.Doc();
        Y.applyUpdate(doc, payload.state);
        await repository.storePageYjsState({
          documentName: payload.documentName,
          snapshot: payload.state,
          replica: readPageYDocReplica(pageId, doc),
        });
      },
    }),
    updateLog: {
      extensionName: "soulstream-page-yjs-update-log",
      async onChange(payload: onChangePayload) {
        const pageId = requirePageDocumentName(payload.documentName);
        await repository.storePageYjsState({
          documentName: payload.documentName,
          snapshot: Y.encodeStateAsUpdate(payload.document),
          update: payload.update,
          replica: readPageYDocReplica(pageId, payload.document),
        });
      },
    },
  };
}

function requirePageDocumentName(documentName: string): string {
  const pageId = parsePageYjsDocumentName(documentName);
  if (!pageId) throw new Error(`PAGE_YJS_DOCUMENT_NAME_INVALID: ${documentName}`);
  return pageId;
}
