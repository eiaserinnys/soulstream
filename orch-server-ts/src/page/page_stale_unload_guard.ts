import type { Extension } from "@hocuspocus/server";

// Hocuspocus schedules `unloadDocument(document)` with setTimeout(0) after a store, but
// removes the registry entry by document name. A timer left by a closed connection would
// otherwise evict a document registered under the same name afterwards.
export const pageStaleUnloadGuard: Extension = {
  async beforeUnloadDocument({ instance, documentName, document }) {
    if (instance.documents.get(documentName) !== document) {
      throw new Error(`stale unload of replaced page document: ${documentName}`);
    }
  },
};
