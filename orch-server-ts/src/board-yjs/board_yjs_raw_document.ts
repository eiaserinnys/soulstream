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
): string {
  const hash = createHash("sha256");
  appendBytes(hash, snapshot);
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
  const snapshot = new Uint8Array(snapshotValue);
  return {
    snapshot,
    revision: computeBoardYjsRawRevision(snapshot),
  };
}

function appendBytes(hash: ReturnType<typeof createHash>, bytes: Uint8Array): void {
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(bytes.byteLength);
  hash.update(length);
  hash.update(bytes);
}
