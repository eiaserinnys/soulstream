import { createHash } from "node:crypto";

import * as Y from "yjs";

import type { BoardYjsRawDocument } from "./board_yjs_persistence.js";
import { BOARD_ITEMS_MAP, MARKDOWN_BODIES_MAP } from "./board_yjs_document.js";
import {
  getCanonicalRunbookDocumentName,
  hasBoardYjsRunbookResidue,
  inspectBoardYjsRunbookResidue,
  migrateBoardYjsRunbookResidue,
  type BoardYjsRunbookResidue,
} from "./board_yjs_runbook_residue.js";

export interface BoardYjsRunbookMigrationPlan {
  sourceDocumentName: string;
  canonicalDocumentName: string;
  sourceRevision: string;
  canonicalRevision: string | null;
  sourceContentHash: string;
  canonicalContentHash: string | null;
  migratedContentHash: string;
  collisionContentHash: string | null;
  planFingerprint: string;
  targetCollision: boolean;
  targetEquivalent: boolean | null;
  opaqueBoardItemIds: string[];
  opaqueBoardItemIdsPreserved: boolean;
  before: BoardYjsRunbookResidue;
  after: BoardYjsRunbookResidue;
}

export interface ComputedBoardYjsRunbookMigrationPlan {
  plan: BoardYjsRunbookMigrationPlan;
  migratedDocument: Y.Doc;
  migratedSnapshot: Uint8Array;
}

export function recomposeBoardYjsRawDocument(state: BoardYjsRawDocument): Y.Doc {
  const doc = new Y.Doc();
  if (state.snapshot.byteLength > 0) Y.applyUpdate(doc, state.snapshot);
  for (const update of state.updates) {
    if (update.byteLength > 0) Y.applyUpdate(doc, update);
  }
  return doc;
}

export function createBoardYjsRunbookMigrationPlan(input: {
  sourceDocumentName: string;
  source: BoardYjsRawDocument;
  canonical: BoardYjsRawDocument | null;
}): ComputedBoardYjsRunbookMigrationPlan {
  const canonicalDocumentName = getCanonicalRunbookDocumentName(input.sourceDocumentName);
  const sourceDocument = recomposeBoardYjsRawDocument(input.source);
  const before = inspectBoardYjsRunbookResidue(input.sourceDocumentName, sourceDocument);
  if (!hasBoardYjsRunbookResidue(before)) {
    throw new Error(`board Y.Doc has no runbook residue: ${input.sourceDocumentName}`);
  }

  const migratedDocument = cloneDocument(sourceDocument);
  const migration = migrateBoardYjsRunbookResidue(
    input.sourceDocumentName,
    migratedDocument,
  );
  const canonicalDocument = materializeCanonicalBoardDocument(migratedDocument);
  const migratedSnapshot = Y.encodeStateAsUpdate(canonicalDocument);
  const sourceContentHash = hashBoardYjsDocument(sourceDocument);
  const migratedContentHash = hashBoardYjsDocument(canonicalDocument);
  const targetCollision = canonicalDocumentName !== input.sourceDocumentName &&
    input.canonical !== null;
  let canonicalContentHash: string | null = null;
  let canonicalMigratedContentHash: string | null = null;
  let canonicalOpaqueBoardItemIds: string[] = [];

  if (targetCollision && input.canonical) {
    const canonicalDocument = recomposeBoardYjsRawDocument(input.canonical);
    canonicalContentHash = hashBoardYjsDocument(canonicalDocument);
    const canonicalMigration = migrateBoardYjsRunbookResidue(
      canonicalDocumentName,
      canonicalDocument,
    );
    canonicalMigratedContentHash = hashBoardYjsDocument(canonicalDocument);
    canonicalOpaqueBoardItemIds = canonicalMigration.after.opaqueBoardItemIds;
  }

  const sourceOpaqueBoardItemIds = migration.after.opaqueBoardItemIds;
  const opaqueBoardItemIds = [...new Set([
    ...sourceOpaqueBoardItemIds,
    ...canonicalOpaqueBoardItemIds,
  ])].sort();
  const opaqueBoardItemIdsPreserved = !targetCollision ||
    sourceOpaqueBoardItemIds.every((id) => canonicalOpaqueBoardItemIds.includes(id));
  const targetEquivalent = targetCollision
    ? migratedContentHash === canonicalMigratedContentHash
    : null;
  const collisionContentHash = targetCollision
    ? hashStableValue({
      source: migratedContentHash,
      canonical: canonicalMigratedContentHash,
    })
    : null;
  const fingerprintInput = {
    sourceDocumentName: input.sourceDocumentName,
    canonicalDocumentName,
    sourceContentHash,
    canonicalContentHash,
    migratedContentHash,
    canonicalMigratedContentHash,
    collisionContentHash,
    targetCollision,
    targetEquivalent,
    opaqueBoardItemIds,
    opaqueBoardItemIdsPreserved,
    before,
    after: migration.after,
  };

  return {
    plan: {
      sourceDocumentName: input.sourceDocumentName,
      canonicalDocumentName,
      sourceRevision: input.source.revision,
      canonicalRevision: input.canonical?.revision ?? null,
      sourceContentHash,
      canonicalContentHash,
      migratedContentHash,
      collisionContentHash,
      planFingerprint: hashStableValue(fingerprintInput),
      targetCollision,
      targetEquivalent,
      opaqueBoardItemIds,
      opaqueBoardItemIdsPreserved,
      before,
      after: migration.after,
    },
    migratedDocument: canonicalDocument,
    migratedSnapshot,
  };
}

export function hashBoardYjsDocument(doc: Y.Doc): string {
  const boardItems = [...doc.getMap<unknown>(BOARD_ITEMS_MAP).entries()]
    .sort(([left], [right]) => left.localeCompare(right));
  const markdownBodies = [...doc.getMap<Y.Text>(MARKDOWN_BODIES_MAP).entries()]
    .map(([id, text]) => [id, text.toDelta()] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  return hashStableValue({ boardItems, markdownBodies });
}

function cloneDocument(doc: Y.Doc): Y.Doc {
  const clone = new Y.Doc();
  Y.applyUpdate(clone, Y.encodeStateAsUpdate(doc));
  return clone;
}

function materializeCanonicalBoardDocument(source: Y.Doc): Y.Doc {
  const unsupported = [...source.share.keys()].filter((name) =>
    name !== BOARD_ITEMS_MAP && name !== MARKDOWN_BODIES_MAP
  );
  if (unsupported.length > 0) {
    throw new Error(`unsupported board Y.Doc shared types: ${JSON.stringify(unsupported)}`);
  }
  const target = new Y.Doc();
  const sourceItems = source.getMap<unknown>(BOARD_ITEMS_MAP);
  const targetItems = target.getMap<unknown>(BOARD_ITEMS_MAP);
  const sourceBodies = source.getMap<Y.Text>(MARKDOWN_BODIES_MAP);
  const targetBodies = target.getMap<Y.Text>(MARKDOWN_BODIES_MAP);
  target.transact(() => {
    for (const [id, value] of sourceItems.entries()) targetItems.set(id, value);
    for (const [id, text] of sourceBodies.entries()) {
      const copy = new Y.Text();
      copy.applyDelta(text.toDelta());
      targetBodies.set(id, copy);
    }
  });
  return target;
}

function hashStableValue(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(sortValue(value))).digest("hex");
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortValue(entry)]),
  );
}
