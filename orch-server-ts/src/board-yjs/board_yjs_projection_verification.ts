import type { CatalogBoardItemRow } from "./board_yjs_types.js";

export function requireBoardItemCatalogProjection<T>(input: {
  label: string;
  ydocItemCount: number;
  projection: T | null;
}): T | null {
  if (input.projection !== null) return input.projection;
  if (input.ydocItemCount === 0) return null;
  throw new Error(`missing catalog projection for board Y.Doc: ${input.label}`);
}

export function assertBoardItemProjectionParity(input: {
  label: string;
  ydocItems: readonly CatalogBoardItemRow[];
  projectionItems: readonly CatalogBoardItemRow[];
}): void {
  const difference = inspectBoardItemProjectionDifference(input);
  if (hasDifference(difference)) {
    throw new Error(
      `${input.label} board item projection mismatch: ` +
        `${JSON.stringify(difference)}`,
    );
  }
}

export function inspectBoardItemProjectionDifference(input: {
  ydocItems: readonly CatalogBoardItemRow[];
  projectionItems: readonly CatalogBoardItemRow[];
}): BoardItemProjectionDifference {
  const ydoc = normalizeItems(input.ydocItems);
  const projection = normalizeItems(input.projectionItems);
  return describeDifference(ydoc, projection);
}

export function inspectBoardItemMembershipDifference(input: {
  ydocItems: readonly CatalogBoardItemRow[];
  projectionItems: readonly CatalogBoardItemRow[];
}): BoardItemMembershipDifference {
  const ydocIds = normalizeMembershipIds(input.ydocItems);
  const projectionIds = normalizeMembershipIds(input.projectionItems);
  const ydoc = new Set(ydocIds);
  const projection = new Set(projectionIds);
  return {
    missingFromProjection: ydocIds.filter((id) => !projection.has(id)),
    missingFromYdoc: projectionIds.filter((id) => !ydoc.has(id)),
  };
}

export function inspectCrossDocumentBoardItemDuplicates(
  documents: readonly BoardYjsDocumentBoardItemIds[],
): CrossDocumentBoardItemDuplicate[] {
  const documentNamesByBoardItemId = new Map<string, Set<string>>();
  for (const document of documents) {
    for (const boardItemId of document.boardItemIds) {
      const documentNames = documentNamesByBoardItemId.get(boardItemId) ?? new Set();
      documentNames.add(document.documentName);
      documentNamesByBoardItemId.set(boardItemId, documentNames);
    }
  }
  return [...documentNamesByBoardItemId.entries()]
    .filter(([, documentNames]) => documentNames.size > 1)
    .map(([boardItemId, documentNames]) => ({
      boardItemId,
      documentNames: [...documentNames].sort((left, right) => left.localeCompare(right)),
    }))
    .sort((left, right) => left.boardItemId.localeCompare(right.boardItemId));
}

export function assertNoCrossDocumentBoardItemDuplicates(
  documents: readonly BoardYjsDocumentBoardItemIds[],
): void {
  const duplicates = inspectCrossDocumentBoardItemDuplicates(documents);
  if (duplicates.length === 0) return;
  const documentCount = new Set(
    duplicates.flatMap((duplicate) => duplicate.documentNames),
  ).size;
  throw new Error(
    "board item IDs occur in multiple Y.Doc documents: " +
      `${duplicates.length} IDs across ${documentCount} documents; see report above`,
  );
}

export function assertNoBoardItemMembershipMismatches(
  mismatches: readonly BoardItemMembershipMismatch[],
): void {
  if (mismatches.length === 0) return;
  const mismatchCount = mismatches.reduce(
    (total, mismatch) => total + mismatch.ydocOnly.length +
      mismatch.boardItemsOnly.length,
    0,
  );
  throw new Error(
    `board_items projection mismatch: ${mismatchCount} rows across ` +
      `${mismatches.length} containers; see report above`,
  );
}

function normalizeItems(items: readonly CatalogBoardItemRow[]): NormalizedBoardItem[] {
  const normalized = items.map((item) => ({
    id: item.id,
    folderId: item.folderId,
    containerKind: item.containerKind ?? "folder",
    containerId: item.containerId ?? item.folderId,
    membershipKind: item.membershipKind ?? "primary",
    sourceTaskItemId: item.sourceTaskItemId ?? null,
    itemType: item.itemType,
    itemId: item.itemId,
    x: Number(item.x),
    y: Number(item.y),
    metadata: sortValue(item.metadata ?? {}),
  })).sort((left, right) => left.id.localeCompare(right.id));
  const duplicate = normalized.find((item, index) =>
    index > 0 && normalized[index - 1]?.id === item.id
  );
  if (duplicate) throw new Error(`duplicate board item ID: ${duplicate.id}`);
  return normalized;
}

function normalizeMembershipIds(items: readonly CatalogBoardItemRow[]): string[] {
  const ids = items.map((item) => item.id).sort((left, right) => left.localeCompare(right));
  const duplicate = ids.find((id, index) => index > 0 && ids[index - 1] === id);
  if (duplicate) throw new Error(`duplicate board item ID: ${duplicate}`);
  return ids;
}

function describeDifference(
  ydoc: readonly NormalizedBoardItem[],
  projection: readonly NormalizedBoardItem[],
): BoardItemProjectionDifference {
  const ydocById = new Map(ydoc.map((item) => [item.id, item]));
  const projectionById = new Map(projection.map((item) => [item.id, item]));
  const missingFromProjection = [...ydocById.keys()]
    .filter((id) => !projectionById.has(id));
  const missingFromYdoc = [...projectionById.keys()]
    .filter((id) => !ydocById.has(id));
  const changed = [...ydocById.keys()].filter((id) => {
    const projected = projectionById.get(id);
    return projected !== undefined &&
      JSON.stringify(ydocById.get(id)) !== JSON.stringify(projected);
  });
  return { missingFromProjection, missingFromYdoc, changed };
}

function hasDifference(difference: BoardItemProjectionDifference): boolean {
  return difference.missingFromProjection.length > 0 ||
    difference.missingFromYdoc.length > 0 ||
    difference.changed.length > 0;
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

interface NormalizedBoardItem {
  id: string;
  folderId: string;
  containerKind: string;
  containerId: string;
  membershipKind: string;
  sourceTaskItemId: string | null;
  itemType: string;
  itemId: string;
  x: number;
  y: number;
  metadata: unknown;
}

export interface BoardItemProjectionDifference {
  missingFromProjection: string[];
  missingFromYdoc: string[];
  changed: string[];
}

export interface BoardItemMembershipDifference {
  missingFromProjection: string[];
  missingFromYdoc: string[];
}

export interface BoardYjsDocumentBoardItemIds {
  documentName: string;
  boardItemIds: readonly string[];
}

export interface CrossDocumentBoardItemDuplicate {
  boardItemId: string;
  documentNames: string[];
}

export interface BoardItemMembershipMismatch {
  container: string;
  documentName: string | null;
  ydocOnly: string[];
  boardItemsOnly: string[];
}
