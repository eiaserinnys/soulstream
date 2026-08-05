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
  collisionDifferences: BoardYjsCollisionDifference[] | null;
  opaqueBoardItemIds: string[];
  opaqueBoardItemIdsPreserved: boolean;
  before: BoardYjsRunbookResidue;
  after: BoardYjsRunbookResidue;
}

export interface BoardYjsCollisionDifference {
  surface: "board_item" | "markdown_body";
  id: string;
  path: string;
  legacyValue: string;
  canonicalValue: string;
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
  let collisionDifferences: BoardYjsCollisionDifference[] | null = null;

  if (targetCollision && input.canonical) {
    const canonicalDocument = recomposeBoardYjsRawDocument(input.canonical);
    canonicalContentHash = hashBoardYjsDocument(canonicalDocument);
    const canonicalMigration = migrateBoardYjsRunbookResidue(
      canonicalDocumentName,
      canonicalDocument,
    );
    canonicalMigratedContentHash = hashBoardYjsDocument(canonicalDocument);
    canonicalOpaqueBoardItemIds = canonicalMigration.after.opaqueBoardItemIds;
    collisionDifferences = describeBoardYjsCollision(
      migratedDocument,
      canonicalDocument,
    );
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
      collisionDifferences,
      opaqueBoardItemIds,
      opaqueBoardItemIdsPreserved,
      before,
      after: migration.after,
    },
    migratedDocument: canonicalDocument,
    migratedSnapshot,
  };
}

function describeBoardYjsCollision(
  legacy: Y.Doc,
  canonical: Y.Doc,
): BoardYjsCollisionDifference[] {
  const differences: BoardYjsCollisionDifference[] = [];
  const legacyItems = legacy.getMap<unknown>(BOARD_ITEMS_MAP);
  const canonicalItems = canonical.getMap<unknown>(BOARD_ITEMS_MAP);
  const itemIds = [...new Set([...legacyItems.keys(), ...canonicalItems.keys()])].sort();
  for (const id of itemIds) {
    appendValueDifferences({
      surface: "board_item",
      id,
      path: "",
      legacy: legacyItems.has(id) ? legacyItems.get(id) : MISSING,
      canonical: canonicalItems.has(id) ? canonicalItems.get(id) : MISSING,
      differences,
    });
  }

  const legacyBodies = legacy.getMap<Y.Text>(MARKDOWN_BODIES_MAP);
  const canonicalBodies = canonical.getMap<Y.Text>(MARKDOWN_BODIES_MAP);
  const bodyIds = [...new Set([...legacyBodies.keys(), ...canonicalBodies.keys()])].sort();
  for (const id of bodyIds) {
    appendValueDifferences({
      surface: "markdown_body",
      id,
      path: "text",
      legacy: legacyBodies.has(id) ? legacyBodies.get(id)?.toString() : MISSING,
      canonical: canonicalBodies.has(id) ? canonicalBodies.get(id)?.toString() : MISSING,
      differences,
    });
  }
  return differences;
}

const MISSING = Symbol("missing");

function appendValueDifferences(input: {
  surface: BoardYjsCollisionDifference["surface"];
  id: string;
  path: string;
  legacy: unknown | typeof MISSING;
  canonical: unknown | typeof MISSING;
  differences: BoardYjsCollisionDifference[];
}): void {
  if (input.legacy !== MISSING && input.canonical !== MISSING &&
    isPlainRecord(input.legacy) && isPlainRecord(input.canonical)) {
    const keys = [...new Set([
      ...Object.keys(input.legacy),
      ...Object.keys(input.canonical),
    ])].sort();
    for (const key of keys) {
      appendValueDifferences({
        ...input,
        path: input.path ? `${input.path}.${key}` : key,
        legacy: key in input.legacy ? input.legacy[key] : MISSING,
        canonical: key in input.canonical ? input.canonical[key] : MISSING,
      });
    }
    return;
  }
  const legacyValue = describeValue(input.legacy);
  const canonicalValue = describeValue(input.canonical);
  if (legacyValue === canonicalValue) return;
  input.differences.push({
    surface: input.surface,
    id: input.id,
    path: input.path || "(value)",
    legacyValue,
    canonicalValue,
  });
}

function describeValue(value: unknown | typeof MISSING): string {
  if (value === MISSING) return "(missing)";
  const serialized = JSON.stringify(sortValue(value)) ?? "undefined";
  if (serialized.length <= 240) return serialized;
  return JSON.stringify({
    preview: `${serialized.slice(0, 200)}…`,
    serializedLength: serialized.length,
    sha256: createHash("sha256").update(serialized).digest("hex"),
  });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
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
