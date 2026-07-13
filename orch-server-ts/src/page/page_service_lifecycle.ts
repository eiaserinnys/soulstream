import type { Hocuspocus } from "@hocuspocus/server";

import type { PageYjsPersistence } from "./page_yjs_persistence.js";

export interface PageYjsServiceDiagnostics {
  activeDocuments: number;
  activeConnections: number;
  pendingStores: number;
  executingStores: number;
  activeRepositoryStores: number;
  failedStores: number;
  pendingUpdateBytes: number;
  pendingUpdateDocuments: number;
  retryAttempts: number;
}

export async function closePageYjsRuntime(
  hocuspocus: Hocuspocus,
  persistence: PageYjsPersistence,
): Promise<void> {
  const documents = [...hocuspocus.documents.values()];
  await Promise.all(documents.map(async (document) => {
    const debounceId = `onStoreDocument-${document.name}`;
    if (hocuspocus.debouncer.isDebounced(debounceId)) {
      await hocuspocus.debouncer.executeNow(debounceId);
    }
    await document.saveMutex.waitForUnlock();
  }));
  const beforeClose = persistence.getDiagnostics();
  if (beforeClose.pendingUpdateDocuments > 0) {
    throw new Error(
      `Page Yjs close blocked by ${beforeClose.pendingUpdateDocuments} unpersisted document(s)`,
    );
  }
  hocuspocus.closeConnections();
  await Promise.all(documents.map(async (document) => {
    await hocuspocus.unloadDocument(document);
  }));
  await hocuspocus.hooks("onDestroy", { instance: hocuspocus });
}

export function getPageYjsServiceDiagnostics(
  hocuspocus: Hocuspocus,
  persistence: PageYjsPersistence,
): PageYjsServiceDiagnostics {
  let pendingStores = 0;
  let executingStores = 0;
  for (const document of hocuspocus.documents.values()) {
    const debounceId = `onStoreDocument-${document.name}`;
    if (hocuspocus.debouncer.isDebounced(debounceId)) pendingStores += 1;
    if (hocuspocus.debouncer.isCurrentlyExecuting(debounceId)) executingStores += 1;
  }
  const state = persistence.getDiagnostics();
  return {
    activeDocuments: hocuspocus.getDocumentsCount(),
    activeConnections: hocuspocus.getConnectionsCount(),
    pendingStores,
    executingStores,
    activeRepositoryStores: state.activeStores,
    failedStores: state.failedStores,
    pendingUpdateBytes: state.pendingUpdateBytes,
    pendingUpdateDocuments: state.pendingUpdateDocuments,
    retryAttempts: state.retryAttempts,
  };
}
