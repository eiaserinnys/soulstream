import { readFile } from "node:fs/promises";

import postgres from "postgres";
import * as Y from "yjs";

import {
  BOARD_ITEMS_MAP,
  parseBoardYjsDocumentName,
  readBoardYDocReplica,
} from "../src/board-yjs/board_yjs_model.js";
import {
  assertBoardItemProjectionParity,
  boardItemMembershipMismatchDisposition,
  inspectBoardItemMembershipDifference,
  KNOWN_FOLDER_BOARD_ITEM_DRIFT_WARNING,
  requireBoardItemCatalogProjection,
} from
  "../src/board-yjs/board_yjs_projection_verification.js";
import {
  findMissingSourceTaskItemReferences,
  normalizeMissingSourceTaskItemReferences,
  type MissingSourceTaskItemReference,
} from
  "../src/board-yjs/board_yjs_replica_normalization.js";
import { inspectBoardYjsRunbookResidue } from
  "../src/board-yjs/board_yjs_runbook_residue.js";
import {
  toCatalogBoardItemRow,
  type BoardItemDbRow,
} from "../src/board-yjs/board_projection_serialization.js";
import type { CatalogBoardItemRow } from "../src/board-yjs/board_yjs_types.js";

interface DocumentRow {
  name: string;
  snapshot: Buffer | Uint8Array;
}

interface UpdateRow {
  document_name: string;
  update: Buffer | Uint8Array;
}

interface CatalogRow {
  folder_id: string;
  container_kind: "folder" | "task";
  container_id: string;
  board_items: CatalogBoardItemRow[];
}

const sql = postgres(requiredEnv("DATABASE_URL"), { max: 1 });

try {
  const inventory = await sql.begin(async (transaction) => {
    await transaction`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`;
    const documents = await transaction<DocumentRow[]>`
      SELECT name, snapshot FROM board_yjs_documents
      WHERE name LIKE 'board:%' OR name LIKE 'board-folder:%'
      ORDER BY name
    `;
    const updates = await transaction<UpdateRow[]>`
      SELECT document_name, update FROM board_yjs_updates
      WHERE document_name LIKE 'board:%' OR document_name LIKE 'board-folder:%'
      ORDER BY document_name, id
    `;
    const catalog = await transaction<CatalogRow[]>`
      SELECT folder_id, container_kind, container_id, board_items
      FROM board_yjs_catalog_cache
      ORDER BY container_kind, container_id
    `;
    const sourceTaskItems = await transaction<readonly { id: string }[]>`
      SELECT id FROM task_items ORDER BY id
    `;
    const boardItems = await transaction<BoardItemDbRow[]>`
      SELECT
        id, folder_id, container_kind, container_id, membership_kind,
        source_task_item_id, item_type, item_id, x, y, metadata, created_at, updated_at
      FROM board_items
      ORDER BY id
    `;
    const projections = await transaction<Array<{
      tasks: number;
      tasks_without_page: number;
      task_ref_blocks: number;
      runbook_ref_blocks: number;
      board_items_runbook: number;
      catalog_runbook: number;
      catalog_legacy_source_keys: number;
    }>>`
      SELECT
        (SELECT COUNT(*)::int FROM tasks) AS tasks,
        (SELECT COUNT(*)::int FROM tasks WHERE task_page_id IS NULL) AS tasks_without_page,
        (SELECT COUNT(*)::int FROM blocks WHERE block_type = 'task_ref') AS task_ref_blocks,
        (SELECT COUNT(*)::int FROM blocks WHERE block_type = 'runbook_ref')
          AS runbook_ref_blocks,
        (SELECT COUNT(*)::int FROM board_items WHERE item_type = 'runbook')
          AS board_items_runbook,
        (SELECT COUNT(*)::int
         FROM board_yjs_catalog_cache cache,
              LATERAL jsonb_array_elements(cache.board_items) entry
         WHERE entry->>'itemType' = 'runbook' OR entry->>'item_type' = 'runbook')
          AS catalog_runbook,
        (SELECT COUNT(*)::int FROM board_yjs_catalog_cache
         WHERE board_items::text LIKE '%"sourceRunbookItemId"%'
            OR board_items::text LIKE '%"source_runbook_item_id"%')
          AS catalog_legacy_source_keys
    `;
    return {
      documents,
      updates,
      catalog,
      sourceTaskItems,
      boardItems,
      projections: projections[0],
    };
  });

  const updatesByDocument = new Map<string, Uint8Array[]>();
  for (const row of inventory.updates) {
    const values = updatesByDocument.get(row.document_name) ?? [];
    values.push(new Uint8Array(row.update));
    updatesByDocument.set(row.document_name, values);
  }

  let legacyDocumentNames = 0;
  let legacyItemTypes = 0;
  let legacySourceKeys = 0;
  const opaqueBoardItemIds = new Set<string>();
  const catalogByContainer = new Map(inventory.catalog.map((row) => [
    `${row.container_kind}:${row.container_id}`,
    row,
  ]));
  const existingSourceTaskItemIds = new Set(
    inventory.sourceTaskItems.map((row) => row.id),
  );
  const relationalBoardItems = inventory.boardItems.map(toCatalogBoardItemRow);
  const boardItemsNormalizationWarnings = findMissingSourceTaskItemReferences(
    relationalBoardItems,
    existingSourceTaskItemIds,
  );
  const normalizedRelationalBoardItems = normalizeMissingSourceTaskItemReferences(
    { boardItems: relationalBoardItems, markdownDocuments: [] },
    existingSourceTaskItemIds,
  ).boardItems;
  const boardItemsByContainer = groupBoardItemsByContainer(
    normalizedRelationalBoardItems,
  );
  const catalogNormalizationWarnings: MissingSourceTaskItemReference[] = [];
  const normalizedCatalogItemsByContainer = new Map<
    string,
    readonly CatalogBoardItemRow[]
  >();
  for (const cache of inventory.catalog) {
    const containerKey = `${cache.container_kind}:${cache.container_id}`;
    catalogNormalizationWarnings.push(...findMissingSourceTaskItemReferences(
      cache.board_items,
      existingSourceTaskItemIds,
    ));
    normalizedCatalogItemsByContainer.set(
      containerKey,
      normalizeMissingSourceTaskItemReferences(
        { boardItems: cache.board_items, markdownDocuments: [] },
        existingSourceTaskItemIds,
      ).boardItems,
    );
  }
  const normalizedYdocItemsByContainer = new Map<
    string,
    readonly CatalogBoardItemRow[]
  >();
  const documentNameByContainer = new Map<string, string>();
  let boardItemsCompared = 0;
  let emptyDocumentsWithoutCatalog = 0;
  for (const row of inventory.documents) {
    const doc = new Y.Doc();
    if (row.snapshot.byteLength > 0) Y.applyUpdate(doc, new Uint8Array(row.snapshot));
    for (const update of updatesByDocument.get(row.name) ?? []) {
      if (update.byteLength > 0) Y.applyUpdate(doc, update);
    }
    const residue = inspectBoardYjsRunbookResidue(row.name, doc);
    legacyDocumentNames += residue.legacyDocumentName;
    legacyItemTypes += residue.legacyItemTypes;
    legacySourceKeys += residue.legacySourceKeys;
    for (const id of residue.opaqueBoardItemIds) opaqueBoardItemIds.add(id);
    const container = parseBoardYjsDocumentName(row.name);
    if (!container) throw new Error(`invalid board Y.Doc document name: ${row.name}`);
    const containerKey = `${container.containerKind}:${container.containerId}`;
    documentNameByContainer.set(containerKey, row.name);
    const cache = requireBoardItemCatalogProjection({
      label: row.name,
      ydocItemCount: doc.getMap(BOARD_ITEMS_MAP).size,
      projection: catalogByContainer.get(containerKey) ?? null,
    });
    if (!cache) {
      emptyDocumentsWithoutCatalog += 1;
    } else {
      const ydocReplica = readBoardYDocReplica({
        folderId: cache.folder_id,
        containerKind: container.containerKind,
        containerId: container.containerId,
      }, doc);
      const normalizedYdocReplica = normalizeMissingSourceTaskItemReferences(
        ydocReplica,
        existingSourceTaskItemIds,
      );
      normalizedYdocItemsByContainer.set(
        containerKey,
        normalizedYdocReplica.boardItems,
      );
      assertBoardItemProjectionParity({
        label: row.name,
        ydocItems: normalizedYdocReplica.boardItems,
        projectionItems: normalizedCatalogItemsByContainer.get(containerKey) ?? [],
      });
      boardItemsCompared += ydocReplica.boardItems.length;
    }
  }

  const taskBlockingMismatches: BoardItemsProjectionMismatch[] = [];
  const folderWarningMismatches: BoardItemsProjectionMismatch[] = [];
  let relationalBoardItemsCompared = 0;
  let catalogFallbackContainers = 0;
  for (const cache of inventory.catalog) {
    const containerKey = `${cache.container_kind}:${cache.container_id}`;
    const normalizedYdocItems = normalizedYdocItemsByContainer.get(containerKey);
    if (!normalizedYdocItems) catalogFallbackContainers += 1;
    const relationalProjection = boardItemsByContainer.get(containerKey) ?? [];
    const disposition = boardItemMembershipMismatchDisposition(
      cache.container_kind,
    );
    // Folder mismatch is known unresolved drift owned by a separate follow-up.
    // Keep every container and direction visible, but do not block deployment on it yet.
    const target = disposition === "blocking"
      ? taskBlockingMismatches
      : folderWarningMismatches;
    recordBoardItemsProjectionMismatch(
      target,
      containerKey,
      documentNameByContainer.get(containerKey) ?? null,
      normalizedYdocItems ??
        normalizedCatalogItemsByContainer.get(containerKey) ?? [],
      relationalProjection,
    );
    relationalBoardItemsCompared += relationalProjection.length;
  }

  const taskBlockingSummary = summarizeBoardItemsProjectionMismatches(
    taskBlockingMismatches,
    true,
  );
  const folderWarningSummary = summarizeBoardItemsProjectionMismatches(
    folderWarningMismatches,
    false,
  );

  const committedAllowlist = JSON.parse(await readFile(
    new URL("./ydoc-runbook-opaque-board-item-allowlist.json", import.meta.url),
    "utf8",
  )) as string[];
  const report = {
    mode: "verify",
    documentsRecomposed: inventory.documents.length,
    pendingUpdatesApplied: inventory.updates.length,
    boardItemsCompared,
    relationalBoardItemsLoaded: relationalBoardItems.length,
    relationalBoardItemsCompared,
    catalogContainersCompared: inventory.catalog.length,
    recomposedYdocContainersCompared: normalizedYdocItemsByContainer.size,
    catalogFallbackContainers,
    emptyDocumentsWithoutCatalog,
    boardItemsProjection: {
      taskBlocking: taskBlockingSummary,
      folderWarnings: {
        reason: KNOWN_FOLDER_BOARD_ITEM_DRIFT_WARNING,
        ...folderWarningSummary,
      },
    },
    normalizationWarnings: {
      catalog: catalogNormalizationWarnings,
      boardItems: boardItemsNormalizationWarnings,
    },
    ydoc: { legacyDocumentNames, legacyItemTypes, legacySourceKeys },
    opaqueBoardItemIds: [...opaqueBoardItemIds].sort(),
    projections: inventory.projections,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

  assertZero("Y.Doc legacy document names", legacyDocumentNames);
  assertZero("Y.Doc legacy item types", legacyItemTypes);
  assertZero("Y.Doc legacy source keys", legacySourceKeys);
  assertZero("tasks without task_page_id", inventory.projections?.tasks_without_page ?? -1);
  assertZero("runbook_ref blocks", inventory.projections?.runbook_ref_blocks ?? -1);
  assertZero("runbook board_items", inventory.projections?.board_items_runbook ?? -1);
  assertZero("runbook catalog entries", inventory.projections?.catalog_runbook ?? -1);
  assertZero(
    "legacy catalog source keys",
    inventory.projections?.catalog_legacy_source_keys ?? -1,
  );
  assertContainsStrings([...opaqueBoardItemIds], committedAllowlist);
  assertNoBoardItemsProjectionMismatches(taskBlockingMismatches);
  process.stdout.write(
    "Y.Doc recomposition, catalog cache, and board_items projection verification passed.\n",
  );
} finally {
  await sql.end();
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function assertZero(label: string, value: number): void {
  if (value !== 0) throw new Error(`${label} must be zero, received ${value}`);
}

function assertContainsStrings(actual: readonly string[], expected: readonly string[]): void {
  const present = new Set(actual);
  const missing = expected.filter((value) => !present.has(value));
  if (missing.length > 0) {
    throw new Error(`opaque board item IDs were not preserved: ${JSON.stringify(missing)}`);
  }
}

function groupBoardItemsByContainer(
  boardItems: readonly CatalogBoardItemRow[],
): Map<string, CatalogBoardItemRow[]> {
  const grouped = new Map<string, CatalogBoardItemRow[]>();
  for (const item of boardItems) {
    const containerKey = `${item.containerKind ?? "folder"}:` +
      `${item.containerId ?? item.folderId}`;
    const values = grouped.get(containerKey) ?? [];
    values.push(item);
    grouped.set(containerKey, values);
  }
  return grouped;
}

function recordBoardItemsProjectionMismatch(
  mismatches: BoardItemsProjectionMismatch[],
  container: string,
  documentName: string | null,
  ydocItems: readonly CatalogBoardItemRow[],
  boardItems: readonly CatalogBoardItemRow[],
): void {
  const difference = inspectBoardItemMembershipDifference({
    ydocItems,
    projectionItems: boardItems,
  });
  if (difference.missingFromProjection.length === 0 &&
      difference.missingFromYdoc.length === 0) return;
  mismatches.push({
    container,
    documentName,
    ydocOnly: difference.missingFromProjection,
    boardItemsOnly: difference.missingFromYdoc,
  });
}

function assertNoBoardItemsProjectionMismatches(
  mismatches: readonly BoardItemsProjectionMismatch[],
): void {
  if (mismatches.length === 0) return;
  const mismatchCount = mismatches.reduce(
    (total, mismatch) => total + mismatch.ydocOnly.length +
      mismatch.boardItemsOnly.length,
    0,
  );
  throw new Error(
    `task board_items projection mismatch: ${mismatchCount} rows across ` +
      `${mismatches.length} containers; see report above`,
  );
}

function summarizeBoardItemsProjectionMismatches(
  mismatches: readonly BoardItemsProjectionMismatch[],
  includeIds: boolean,
): BoardItemsProjectionMismatchSummary {
  const containers = mismatches.map((mismatch) => ({
    container: mismatch.container,
    documentName: mismatch.documentName,
    ydocOnlyCount: mismatch.ydocOnly.length,
    boardItemsOnlyCount: mismatch.boardItemsOnly.length,
    ...(includeIds
      ? {
        ydocOnly: mismatch.ydocOnly,
        boardItemsOnly: mismatch.boardItemsOnly,
      }
      : {}),
  }));
  const ydocOnlyCount = containers.reduce(
    (total, container) => total + container.ydocOnlyCount,
    0,
  );
  const boardItemsOnlyCount = containers.reduce(
    (total, container) => total + container.boardItemsOnlyCount,
    0,
  );
  return {
    mismatchCount: ydocOnlyCount + boardItemsOnlyCount,
    mismatchContainers: containers.length,
    ydocOnlyCount,
    boardItemsOnlyCount,
    containers,
  };
}

interface BoardItemsProjectionMismatch {
  container: string;
  documentName: string | null;
  ydocOnly: string[];
  boardItemsOnly: string[];
}

interface BoardItemsProjectionMismatchSummary {
  mismatchCount: number;
  mismatchContainers: number;
  ydocOnlyCount: number;
  boardItemsOnlyCount: number;
  containers: Array<{
    container: string;
    documentName: string | null;
    ydocOnlyCount: number;
    boardItemsOnlyCount: number;
    ydocOnly?: string[];
    boardItemsOnly?: string[];
  }>;
}
