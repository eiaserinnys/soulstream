import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import type { BoardYjsRawDocument } from "./board_yjs_persistence.js";
import type { BoardYjsQuerySql } from "./board_yjs_sql.js";

export class BoardYjsMigrationRevisionConflictError extends Error {
  constructor(readonly documentName: string) {
    super(`board Y.Doc changed during runbook migration: ${documentName}`);
    this.name = "BoardYjsMigrationRevisionConflictError";
  }
}

export function computeBoardYjsRawRevision(
  snapshot: Uint8Array,
  updates: readonly Uint8Array[],
): string {
  const hash = createHash("sha256");
  appendBytes(hash, snapshot);
  for (const update of updates) appendBytes(hash, update);
  return hash.digest("hex");
}

export async function loadExactRawBoardYjsDocument(
  sql: BoardYjsQuerySql,
  documentName: string,
  lockDocument: boolean,
): Promise<BoardYjsRawDocument | null> {
  const documents = lockDocument
    ? await sql<readonly { snapshot: Buffer | Uint8Array }[]>`
      SELECT snapshot FROM board_yjs_documents
      WHERE name = ${documentName}
      FOR UPDATE
    `
    : await sql<readonly { snapshot: Buffer | Uint8Array }[]>`
      SELECT snapshot FROM board_yjs_documents WHERE name = ${documentName}
    `;
  const snapshotValue = documents[0]?.snapshot;
  if (!snapshotValue) return null;
  const updateRows = await sql<readonly { update: Buffer | Uint8Array }[]>`
    SELECT update FROM board_yjs_updates
    WHERE document_name = ${documentName}
    ORDER BY id ASC
  `;
  const snapshot = new Uint8Array(snapshotValue);
  const updates = updateRows.map((row) => new Uint8Array(row.update));
  return {
    snapshot,
    updates,
    revision: computeBoardYjsRawRevision(snapshot, updates),
  };
}

function appendBytes(hash: ReturnType<typeof createHash>, bytes: Uint8Array): void {
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(bytes.byteLength);
  hash.update(length);
  hash.update(bytes);
}
