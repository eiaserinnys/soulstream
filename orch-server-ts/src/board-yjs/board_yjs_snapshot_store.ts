import { Buffer } from "node:buffer";

import * as Y from "yjs";

import {
  readBoardYDocReplica,
} from "./board_yjs_model.js";
import { syncBoardYjsReplicaWithSql } from "./board_yjs_replica_sync.js";
import type { BoardYjsQuerySql } from "./board_yjs_sql.js";
import type {
  BoardYjsContainerScope,
  BoardYjsDocumentApplication,
  BoardYjsReplica,
} from "./board_yjs_types.js";

export const BOARD_YJS_SNAPSHOT_CAS_MAX_ATTEMPTS = 8;

export interface BoardYjsSnapshotRecord {
  snapshot: Uint8Array;
  revision: number;
}

export interface BoardYjsSnapshotProjection {
  scope: BoardYjsContainerScope;
  replica: BoardYjsReplica;
}

export class BoardYjsSnapshotCasExhaustedError extends Error {
  constructor(readonly documentName: string, readonly attempts: number) {
    super(`board Y.Doc snapshot CAS exhausted for ${documentName} after ${attempts} attempts`);
    this.name = "BoardYjsSnapshotCasExhaustedError";
  }
}

export async function loadBoardYjsSnapshotWithSql(
  sql: BoardYjsQuerySql,
  documentName: string,
): Promise<BoardYjsSnapshotRecord | null> {
  const rows = await sql<readonly {
    snapshot: Buffer | Uint8Array;
    revision: number;
  }[]>`
    SELECT snapshot, revision
    FROM board_yjs_documents
    WHERE name = ${documentName}
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    snapshot: new Uint8Array(row.snapshot),
    revision: Number(row.revision),
  };
}

export async function compareAndSwapBoardYjsSnapshotWithSql(
  sql: BoardYjsQuerySql,
  input: {
    documentName: string;
    snapshot: Uint8Array;
    expectedRevision: number | null;
    projection?: BoardYjsSnapshotProjection;
  },
): Promise<BoardYjsSnapshotRecord | null> {
  const rows = input.expectedRevision === null
    ? await sql<readonly { revision: number }[]>`
      INSERT INTO board_yjs_documents (name, snapshot, updated_at)
      VALUES (${input.documentName}, ${Buffer.from(input.snapshot)}, NOW())
      ON CONFLICT (name) DO NOTHING
      RETURNING revision
    `
    : await sql<readonly { revision: number }[]>`
      UPDATE board_yjs_documents
      SET snapshot = ${Buffer.from(input.snapshot)},
          updated_at = NOW()
      WHERE name = ${input.documentName}
        AND revision = ${input.expectedRevision}
      RETURNING revision
    `;
  const row = rows[0];
  if (!row) return null;
  if (input.projection) {
    await syncBoardYjsReplicaWithSql(
      sql,
      input.projection.scope,
      input.projection.replica,
      input.documentName,
    );
  }
  return {
    snapshot: input.snapshot,
    revision: Number(row.revision),
  };
}

export async function storeMergedBoardYjsApplicationWithSql(
  sql: BoardYjsQuerySql,
  application: BoardYjsDocumentApplication,
): Promise<BoardYjsSnapshotRecord> {
  for (let attempt = 1; attempt <= BOARD_YJS_SNAPSHOT_CAS_MAX_ATTEMPTS; attempt += 1) {
    const current = await loadBoardYjsSnapshotWithSql(sql, application.documentName);
    const merged = mergeBoardYjsSnapshots(
      application.scope,
      current?.snapshot ?? null,
      application.snapshot,
    );
    const stored = await compareAndSwapBoardYjsSnapshotWithSql(sql, {
      documentName: application.documentName,
      snapshot: merged.snapshot,
      expectedRevision: current?.revision ?? null,
      projection: {
        scope: application.scope,
        replica: merged.replica,
      },
    });
    if (stored) return stored;
  }
  throw new BoardYjsSnapshotCasExhaustedError(
    application.documentName,
    BOARD_YJS_SNAPSHOT_CAS_MAX_ATTEMPTS,
  );
}

export function mergeBoardYjsSnapshots(
  scope: BoardYjsContainerScope,
  currentSnapshot: Uint8Array | null,
  candidateSnapshot: Uint8Array,
): { snapshot: Uint8Array; replica: BoardYjsReplica } {
  const snapshot = mergeYjsSnapshotUpdates(currentSnapshot, candidateSnapshot);
  const doc = new Y.Doc();
  if (snapshot.byteLength > 0) Y.applyUpdate(doc, snapshot);
  return {
    snapshot,
    replica: readBoardYDocReplica(scope, doc),
  };
}

export function mergeYjsSnapshotUpdates(
  currentSnapshot: Uint8Array | null,
  candidateSnapshot: Uint8Array,
): Uint8Array {
  const doc = new Y.Doc();
  if (currentSnapshot && currentSnapshot.byteLength > 0) {
    Y.applyUpdate(doc, currentSnapshot);
  }
  if (candidateSnapshot.byteLength > 0) {
    Y.applyUpdate(doc, candidateSnapshot);
  }
  return Y.encodeStateAsUpdate(doc);
}
