import type { Hocuspocus } from "@hocuspocus/server";
import * as Y from "yjs";

import { parsePageYjsDocumentName, readPageYDocReplica } from "./page_yjs_model.js";

const COMMITTED_PAGE_SNAPSHOT_ORIGIN = Symbol("committed-page-snapshot");

interface CommittedPageSnapshotRepository {
  getPageYjsSnapshot(documentName: string): Promise<Uint8Array | null>;
}

interface CommittedPageSnapshotCoordinator {
  runExclusive<T>(pageId: string, callback: () => Promise<T>): Promise<T>;
}

export function isCommittedPageSnapshotOrigin(origin: unknown): boolean {
  return origin === COMMITTED_PAGE_SNAPSHOT_ORIGIN;
}

export async function syncCommittedPageSnapshot(input: {
  documentName: string;
  repository: CommittedPageSnapshotRepository;
  coordinator: CommittedPageSnapshotCoordinator;
  hocuspocus: Hocuspocus;
  pageLockHeld: boolean;
}): Promise<void> {
  const pageId = parsePageYjsDocumentName(input.documentName);
  if (!pageId) throw new Error(`PAGE_YJS_DOCUMENT_NAME_INVALID: ${input.documentName}`);

  const synchronize = async () => {
    const snapshot = await input.repository.getPageYjsSnapshot(input.documentName);
    if (!snapshot) throw new Error(`page snapshot missing: ${pageId}`);
    validateSnapshot(pageId, snapshot);

    const connection = await input.hocuspocus.openDirectConnection(input.documentName, {
      pageLockHeld: true,
      source: "committed-page-snapshot",
      skipPagePersistence: true,
    });
    try {
      const live = connection.document as unknown as Y.Doc | null;
      if (!live) throw new Error(`page Y.Doc direct connection closed: ${pageId}`);
      Y.applyUpdate(live, snapshot, COMMITTED_PAGE_SNAPSHOT_ORIGIN);
    } finally {
      await connection.disconnect();
    }
  };
  if (input.pageLockHeld) {
    await synchronize();
  } else {
    await input.coordinator.runExclusive(pageId, synchronize);
  }
}

function validateSnapshot(pageId: string, snapshot: Uint8Array): void {
  const document = new Y.Doc();
  Y.applyUpdate(document, snapshot);
  readPageYDocReplica(pageId, document);
}
