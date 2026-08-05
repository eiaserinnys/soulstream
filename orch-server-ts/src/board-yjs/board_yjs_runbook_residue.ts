import * as Y from "yjs";

import { BOARD_ITEMS_MAP, MARKDOWN_BODIES_MAP } from "./board_yjs_document.js";

const LEGACY_DOCUMENT_PREFIX = "board:runbook:";
const CANONICAL_DOCUMENT_PREFIX = "board:task:";
const LEGACY_SOURCE_KEYS = new Map([
  ["source_runbook_item_id", "source_task_item_id"],
  ["sourceRunbookItemId", "sourceTaskItemId"],
]);

export interface BoardYjsRunbookResidue {
  legacyDocumentName: number;
  legacyItemTypes: number;
  legacySourceKeys: number;
  opaqueBoardItemIds: string[];
}

export interface BoardYjsRunbookMigrationResult {
  before: BoardYjsRunbookResidue;
  after: BoardYjsRunbookResidue;
  changedBoardItems: number;
}

export function getCanonicalRunbookDocumentName(documentName: string): string {
  return documentName.startsWith(LEGACY_DOCUMENT_PREFIX)
    ? `${CANONICAL_DOCUMENT_PREFIX}${documentName.slice(LEGACY_DOCUMENT_PREFIX.length)}`
    : documentName;
}

export function inspectBoardYjsRunbookResidue(
  documentName: string,
  doc: Y.Doc,
): BoardYjsRunbookResidue {
  const boardItems = doc.getMap<unknown>(BOARD_ITEMS_MAP);
  let legacyItemTypes = 0;
  let legacySourceKeys = 0;
  const opaqueBoardItemIds: string[] = [];

  for (const [boardItemId, value] of boardItems.entries()) {
    if (boardItemId.startsWith("runbook:")) opaqueBoardItemIds.push(boardItemId);
    visitJson(value, (key, entry) => {
      if (key === "item_type" && entry === "runbook") legacyItemTypes += 1;
      if (LEGACY_SOURCE_KEYS.has(key)) legacySourceKeys += 1;
    });
  }

  return {
    legacyDocumentName: documentName.startsWith(LEGACY_DOCUMENT_PREFIX) ? 1 : 0,
    legacyItemTypes,
    legacySourceKeys,
    opaqueBoardItemIds: opaqueBoardItemIds.sort(),
  };
}

export function migrateBoardYjsRunbookResidue(
  documentName: string,
  doc: Y.Doc,
): BoardYjsRunbookMigrationResult {
  const before = inspectBoardYjsRunbookResidue(documentName, doc);
  const boardItems = doc.getMap<unknown>(BOARD_ITEMS_MAP);
  let changedBoardItems = 0;

  doc.transact(() => {
    for (const [boardItemId, value] of boardItems.entries()) {
      const migrated = migrateJsonValue(value);
      if (migrated.changed) {
        boardItems.set(boardItemId, migrated.value);
        changedBoardItems += 1;
      }
    }
  });

  const canonicalName = getCanonicalRunbookDocumentName(documentName);
  return {
    before,
    after: inspectBoardYjsRunbookResidue(canonicalName, doc),
    changedBoardItems,
  };
}

export function hasBoardYjsRunbookResidue(residue: BoardYjsRunbookResidue): boolean {
  return residue.legacyDocumentName > 0 ||
    residue.legacyItemTypes > 0 ||
    residue.legacySourceKeys > 0;
}

export function getBoardYjsComparableContent(doc: Y.Doc): {
  boardItems: Array<[string, unknown]>;
  markdownBodies: Array<[string, string]>;
} {
  return {
    boardItems: [...doc.getMap<unknown>(BOARD_ITEMS_MAP).entries()]
      .sort(([left], [right]) => left.localeCompare(right)),
    markdownBodies: [...doc.getMap<Y.Text>(MARKDOWN_BODIES_MAP).entries()]
      .map(([id, text]) => [id, text.toString()] as [string, string])
      .sort(([left], [right]) => left.localeCompare(right)),
  };
}

function migrateJsonValue(value: unknown): { value: unknown; changed: boolean } {
  if (Array.isArray(value)) {
    let changed = false;
    const migrated = value.map((entry) => {
      const result = migrateJsonValue(entry);
      changed ||= result.changed;
      return result.value;
    });
    return { value: changed ? migrated : value, changed };
  }
  if (!isPlainRecord(value)) return { value, changed: false };

  let changed = false;
  const migrated: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const canonicalKey = LEGACY_SOURCE_KEYS.get(key) ?? key;
    if (canonicalKey !== key) changed = true;
    const nested = migrateJsonValue(entry);
    changed ||= nested.changed;
    if (canonicalKey === "item_type" && nested.value === "runbook") {
      migrated[canonicalKey] = "task";
      changed = true;
      continue;
    }
    if (!(canonicalKey in migrated) || canonicalKey === key) {
      migrated[canonicalKey] = nested.value;
    }
  }
  return { value: changed ? migrated : value, changed };
}

function visitJson(
  value: unknown,
  visitor: (key: string, value: unknown) => void,
): void {
  if (Array.isArray(value)) {
    for (const entry of value) visitJson(entry, visitor);
    return;
  }
  if (!isPlainRecord(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    visitor(key, entry);
    visitJson(entry, visitor);
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}
