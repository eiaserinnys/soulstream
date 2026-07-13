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
  hasPageOperation?(operationId: string): Promise<boolean>;
}

export interface PageYjsPersistence {
  updateCollector: Extension;
  database: Database;
  getDiagnostics(): PageYjsPersistenceDiagnostics;
}

export interface PageYjsPersistenceCoordinator {
  runExclusive<T>(pageId: string, callback: () => Promise<T>): Promise<T>;
}

export interface PageYjsPersistenceDiagnostics {
  activeStores: number;
  failedStores: number;
  pendingUpdateBytes: number;
  pendingUpdateDocuments: number;
  retryAttempts: number;
}

export interface PageYjsPersistenceOptions {
  maxAttempts?: number;
  onFailure?: (input: {
    documentName: string;
    attempts: number;
    error: unknown;
  }) => void;
  onRetry?: (input: {
    documentName: string;
    attempt: number;
    error: unknown;
  }) => void;
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
  coordinator?: PageYjsPersistenceCoordinator,
  options: PageYjsPersistenceOptions = {},
): PageYjsPersistence {
  const runExclusive = async <T>(pageId: string, callback: () => Promise<T>): Promise<T> =>
    coordinator ? await coordinator.runExclusive(pageId, callback) : await callback();
  const maxAttempts = options.maxAttempts ?? 3;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error("Page Yjs persistence maxAttempts must be a positive integer");
  }
  let activeStores = 0;
  let failedStores = 0;
  let retryAttempts = 0;
  const pendingUpdates = new Map<string, Uint8Array>();

  const mergePendingUpdate = (documentName: string, update: Uint8Array): void => {
    const current = pendingUpdates.get(documentName);
    pendingUpdates.set(
      documentName,
      current ? Y.mergeUpdates([current, update]) : update.slice(),
    );
  };

  const takePendingUpdate = (documentName: string): Uint8Array | undefined => {
    const update = pendingUpdates.get(documentName);
    pendingUpdates.delete(documentName);
    return update;
  };

  const isPersistedOperation = async (value: unknown): Promise<boolean> =>
    typeof value === "string" && repository.hasPageOperation !== undefined &&
    await repository.hasPageOperation(value);

  const storeWithRetry = async (input: StorePageYjsStateInput): Promise<boolean> => {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await repository.storePageYjsState(input);
        return true;
      } catch (error) {
        if (attempt === maxAttempts) {
          failedStores += 1;
          options.onFailure?.({
            documentName: input.documentName,
            attempts: maxAttempts,
            error,
          });
          return false;
        }
        retryAttempts += 1;
        options.onRetry?.({ documentName: input.documentName, attempt, error });
      }
    }
    return false;
  };

  const database = new Database({
    fetch: async (payload: fetchPayload) => {
      const pageId = requirePageDocumentName(payload.documentName);
      const snapshot = await repository.getPageYjsSnapshot(payload.documentName);
      if (!snapshot) throw new PageYjsSnapshotMissingError(pageId);
      const pending = pendingUpdates.get(payload.documentName);
      return pending ? Y.mergeUpdates([snapshot, pending]) : snapshot;
    },
    store: async (payload: storePayload) => {
      const pageId = requirePageDocumentName(payload.documentName);
      const context = payload.context as {
        skipPagePersistence?: unknown;
      } | undefined;
      if (context?.skipPagePersistence === true) return;
      if (await isPersistedOperation(payload.transactionOrigin)) return;
      const update = takePendingUpdate(payload.documentName);
      activeStores += 1;
      try {
        const stored = await runExclusive(pageId, async () =>
          await storeWithRetry({
            documentName: payload.documentName,
            snapshot: payload.state,
            ...(update === undefined ? {} : { update }),
            replica: readPageYDocReplica(pageId, payload.document),
          })
        );
        if (!stored && update !== undefined) {
          mergePendingUpdate(payload.documentName, update);
        }
      } finally {
        activeStores -= 1;
      }
    },
  });

  const updateCollector: Extension = {
    extensionName: "soulstream-page-yjs-update-collector",
    async onChange(payload: onChangePayload) {
      requirePageDocumentName(payload.documentName);
      if (typeof payload.transactionOrigin === "string") return;
      mergePendingUpdate(payload.documentName, payload.update);
    },
  };

  return {
    updateCollector,
    database,
    getDiagnostics: () => ({
      activeStores,
      failedStores,
      pendingUpdateBytes: [...pendingUpdates.values()].reduce(
        (total, update) => total + update.byteLength,
        0,
      ),
      pendingUpdateDocuments: pendingUpdates.size,
      retryAttempts,
    }),
  };
}

function requirePageDocumentName(documentName: string): string {
  const pageId = parsePageYjsDocumentName(documentName);
  if (!pageId) throw new Error(`PAGE_YJS_DOCUMENT_NAME_INVALID: ${documentName}`);
  return pageId;
}
