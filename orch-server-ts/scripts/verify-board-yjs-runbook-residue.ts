import { readFile } from "node:fs/promises";

import postgres from "postgres";
import * as Y from "yjs";

import {
  parseBoardYjsDocumentName,
  readBoardYDocReplica,
} from "../src/board-yjs/board_yjs_model.js";
import { assertBoardItemProjectionParity } from
  "../src/board-yjs/board_yjs_projection_verification.js";
import { inspectBoardYjsRunbookResidue } from
  "../src/board-yjs/board_yjs_runbook_residue.js";
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

interface BoardItemRow {
  id: string;
  folder_id: string;
  container_kind: "folder" | "task";
  container_id: string;
  membership_kind: "primary" | "reference";
  source_task_item_id: string | null;
  item_type: CatalogBoardItemRow["itemType"];
  item_id: string;
  x: string | number;
  y: string | number;
  metadata: Record<string, unknown> | null;
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
    const boardItems = await transaction<BoardItemRow[]>`
      SELECT id, folder_id, container_kind, container_id, membership_kind,
             source_task_item_id, item_type, item_id, x, y, metadata
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
    return { documents, updates, catalog, boardItems, projections: projections[0] };
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
  const ydocBoardItems: CatalogBoardItemRow[] = [];
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
    const cache = catalogByContainer.get(`${container.containerKind}:${container.containerId}`);
    if (!cache) throw new Error(`missing catalog projection for board Y.Doc: ${row.name}`);
    const replicaItems = readBoardYDocReplica({
      folderId: cache.folder_id,
      containerKind: container.containerKind,
      containerId: container.containerId,
    }, doc).boardItems;
    assertBoardItemProjectionParity({
      label: row.name,
      ydocItems: replicaItems,
      projectionItems: cache.board_items,
    });
    ydocBoardItems.push(...replicaItems);
  }

  assertBoardItemProjectionParity({
    label: "all board Y.Doc documents",
    ydocItems: ydocBoardItems,
    projectionItems: inventory.boardItems.map(toCatalogBoardItem),
  });

  const committedAllowlist = JSON.parse(await readFile(
    new URL("./ydoc-runbook-opaque-board-item-allowlist.json", import.meta.url),
    "utf8",
  )) as string[];
  const report = {
    mode: "verify",
    documentsRecomposed: inventory.documents.length,
    pendingUpdatesApplied: inventory.updates.length,
    boardItemsCompared: ydocBoardItems.length,
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
  process.stdout.write("Y.Doc recomposition and SQL projection verification passed.\n");
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

function toCatalogBoardItem(row: BoardItemRow): CatalogBoardItemRow {
  return {
    id: row.id,
    folderId: row.folder_id,
    containerKind: row.container_kind,
    containerId: row.container_id,
    membershipKind: row.membership_kind,
    sourceTaskItemId: row.source_task_item_id,
    itemType: row.item_type,
    itemId: row.item_id,
    x: Number(row.x),
    y: Number(row.y),
    metadata: row.metadata ?? {},
  };
}
