import { Buffer } from "node:buffer";
import * as Y from "yjs";

import type { BoardYjsSql } from "../board-yjs/board_yjs_sql.js";
import { parseBoardYjsDocumentName, readBoardYDocReplica } from "../board-yjs/board_yjs_document.js";
import { syncBoardYjsReplicaWithSql } from "../board-yjs/board_yjs_replica_sync.js";
import { readPageYDocReplica } from "../page/page_yjs_model.js";
import { reconcileBlockProjection, upsertPageProjection } from "../page/page_repository_projection.js";
import { reconcilePageLinks } from "../page/page_link_projection.js";
import { transformFolderStorageSnapshot } from "./folder_storage_migration.js";

/** One-time release step. Run after migration 108, before starting orch. */
export async function migrateFolderStorageDocuments(sql: BoardYjsSql) {
  return await sql.begin(async (transaction) => {
    const rows = await transaction<readonly { name: string; snapshot: Buffer }[]>`
      SELECT name, snapshot FROM board_yjs_documents
      WHERE name LIKE 'board:%' OR name LIKE 'board-folder:%' OR name LIKE 'page:%'
      ORDER BY name FOR UPDATE
    `;
    const documents = rows.map((row) => ({
      originalName: row.name,
      ...transformFolderStorageSnapshot(row.name, row.snapshot),
    }));
    const changed = documents.filter((document) => document.changed);
    if (changed.length === 0) return { changedDocuments: 0 };
    const names = new Set(rows.map((row) => row.name));
    for (const document of changed) {
      if (document.name !== document.originalName && names.has(document.name)) {
        throw new Error(`Folder document already exists: ${document.name}`);
      }
    }
    for (const document of changed) {
      await transaction`
        UPDATE board_yjs_documents
        SET name = ${document.name}, snapshot = ${Buffer.from(document.snapshot)}, updated_at = NOW()
        WHERE name = ${document.originalName}
      `;
    }
    // The relational migration invalidates the derived board catalog as a whole.
    for (const document of documents) {
      const scope = parseBoardYjsDocumentName(document.name);
      if (!scope && !document.changed) continue;
      const doc = new Y.Doc();
      try {
        Y.applyUpdate(doc, document.snapshot);
        if (scope) {
          const replica = readBoardYDocReplica(scope, doc);
          const existing = await transaction<readonly { id: string }[]>`SELECT id FROM board_items WHERE folder_id = ${scope.folderId}`;
          const before = new Set(existing.map(item => item.id));
          const after = new Set(replica.boardItems.map(item => item.id));
          if (before.size !== after.size || [...before].some(id => !after.has(id))) {
            throw new Error(`Folder migration would change board membership: ${document.name} SQL=${before.size}, Y.Doc=${after.size}`);
          }
          await syncBoardYjsReplicaWithSql(transaction, scope, replica, document.name);
        } else if (document.name.startsWith("page:")) {
          const replica = readPageYDocReplica(document.name.slice("page:".length), doc);
          await upsertPageProjection(transaction, replica);
          await reconcileBlockProjection(transaction, replica);
          await reconcilePageLinks(transaction, replica);
        }
      } finally {
        doc.destroy();
      }
    }
    return { changedDocuments: changed.length };
  });
}
