import type { Hocuspocus } from "@hocuspocus/server";
import type * as Y from "yjs";

import type { PageYjsService } from "../../src/page/page_service.js";

export interface LivePageDocument {
  document: Y.Doc;
  edit(change: (document: Y.Doc) => void): void;
  close(): Promise<void>;
}

/**
 * Holds a page document open on the service's real Hocuspocus instance through
 * a direct connection. `edit` applies a plain document change (collected by the
 * update collector like any non-operation edit) and schedules the debounced
 * store the way Hocuspocus does for a connection edit.
 */
export async function openLivePageDocument(
  service: PageYjsService,
  pageId: string,
): Promise<LivePageDocument> {
  const hocuspocus = (service as unknown as { hocuspocus: Hocuspocus }).hocuspocus;
  const connection = await hocuspocus.openDirectConnection(`page:${pageId}`, {
    source: "live-document-test",
  });
  const live = connection.document;
  if (!live) throw new Error(`live document closed: ${pageId}`);
  return {
    document: live as unknown as Y.Doc,
    edit(change) {
      change(live as unknown as Y.Doc);
      void hocuspocus.storeDocumentHooks(live, {
        clientsCount: live.getConnectionsCount(),
        context: connection.context,
        document: live,
        documentName: live.name,
        instance: hocuspocus,
        requestHeaders: {},
        requestParameters: new URLSearchParams(),
        socketId: "server",
      } as never);
    },
    close: async () => await connection.disconnect(),
  };
}
