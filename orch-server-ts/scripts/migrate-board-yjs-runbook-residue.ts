import { readFile } from "node:fs/promises";

import postgres from "postgres";
import * as Y from "yjs";

import { BoardYjsRepository } from "../src/board-yjs/board_yjs_repository.js";
import { assertBoardYjsQuiescedApplyPreflight } from
  "../src/board-yjs/board_yjs_quiesced_preflight.js";
import { executeQuiescedBoardYjsRunbookMigration } from
  "../src/board-yjs/board_yjs_runbook_migration.js";
import {
  hasBoardYjsRunbookResidue,
  inspectBoardYjsRunbookResidue,
} from "../src/board-yjs/board_yjs_runbook_residue.js";
import {
  createBoardYjsRunbookMigrationPlan,
  type BoardYjsRunbookMigrationPlan,
} from "../src/board-yjs/board_yjs_runbook_plan.js";
import { computeBoardYjsRawRevision } from
  "../src/board-yjs/board_yjs_raw_document.js";
import type { BoardYjsRawDocument } from "../src/board-yjs/board_yjs_persistence.js";
import type { LivePostgresSql } from "../src/runtime/live_db_sql.js";

interface DocumentRow {
  name: string;
  snapshot: Buffer | Uint8Array;
  updated_at: Date | string;
}

interface UpdateRow {
  document_name: string;
  update: Buffer | Uint8Array;
}

const apply = process.argv.includes("--apply");
const summaryOnly = process.argv.includes("--summary");
const approvedCollisionHashesPath = readOption("--approved-collision-hashes");
await assertBoardYjsQuiescedApplyPreflight({
  apply,
  quiescedAcknowledged: process.argv.includes("--quiesced"),
  orchHealthUrl: readOption("--orch-health-url") ??
    process.env.ORCH_HEALTH_URL?.trim() ?? null,
});
const databaseUrl = requiredEnv("DATABASE_URL");
const sql = postgres(databaseUrl, { max: 1 });
const repository = new BoardYjsRepository({
  resolveSql: async () => sql as unknown as LivePostgresSql,
  close: async () => undefined,
});

try {
  const inventory = await sql.begin(async (transaction) => {
    await transaction`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`;
    const documents = await transaction<DocumentRow[]>`
      SELECT name, snapshot, updated_at
      FROM board_yjs_documents
      WHERE name LIKE 'board:%' OR name LIKE 'board-folder:%'
      ORDER BY name
    `;
    const updates = await transaction<UpdateRow[]>`
      SELECT document_name, update
      FROM board_yjs_updates
      WHERE document_name LIKE 'board:%' OR document_name LIKE 'board-folder:%'
      ORDER BY document_name, id
    `;
    const projection = await transaction<Array<{
      board_items_runbook: number;
      catalog_runbook: number;
      blocks_runbook_ref: number;
    }>>`
      SELECT
        (SELECT COUNT(*)::int FROM board_items WHERE item_type = 'runbook')
          AS board_items_runbook,
        (SELECT COUNT(*)::int
         FROM board_yjs_catalog_cache cache,
              LATERAL jsonb_array_elements(cache.board_items) entry
         WHERE entry->>'itemType' = 'runbook' OR entry->>'item_type' = 'runbook')
          AS catalog_runbook,
        (SELECT COUNT(*)::int FROM blocks WHERE block_type = 'runbook_ref')
          AS blocks_runbook_ref
    `;
    return { documents, updates, projection: projection[0] };
  });

  const updatesByDocument = new Map<string, Uint8Array[]>();
  for (const row of inventory.updates) {
    const values = updatesByDocument.get(row.document_name) ?? [];
    values.push(new Uint8Array(row.update));
    updatesByDocument.set(row.document_name, values);
  }
  const rawByName = new Map<string, BoardYjsRawDocument>();
  for (const row of inventory.documents) {
    const snapshot = new Uint8Array(row.snapshot);
    const updates = updatesByDocument.get(row.name) ?? [];
    rawByName.set(row.name, {
      snapshot,
      updates,
      revision: computeBoardYjsRawRevision(snapshot, updates),
    });
  }
  const affected: Array<BoardYjsRunbookMigrationPlan & {
    pendingUpdates: number;
    lastUpdatedAt: string;
  }> = [];
  const opaqueBoardItemIds = new Set<string>();
  let legacyDocumentNames = 0;
  let legacyItemTypes = 0;
  let legacySourceKeys = 0;
  let plannedLegacyDocumentNames = 0;
  let plannedLegacyItemTypes = 0;
  let plannedLegacySourceKeys = 0;

  for (const row of inventory.documents) {
    const source = rawByName.get(row.name)!;
    const updates = updatesByDocument.get(row.name) ?? [];
    const sourceDoc = new Y.Doc();
    if (source.snapshot.byteLength > 0) Y.applyUpdate(sourceDoc, source.snapshot);
    for (const update of source.updates) Y.applyUpdate(sourceDoc, update);
    const before = inspectBoardYjsRunbookResidue(row.name, sourceDoc);
    for (const id of before.opaqueBoardItemIds) opaqueBoardItemIds.add(id);
    if (!hasBoardYjsRunbookResidue(before)) continue;
    const canonicalDocumentName = row.name.startsWith("board:runbook:")
      ? `board:task:${row.name.slice("board:runbook:".length)}`
      : row.name;
    const computed = createBoardYjsRunbookMigrationPlan({
      sourceDocumentName: row.name,
      source,
      canonical: canonicalDocumentName === row.name
        ? null
        : rawByName.get(canonicalDocumentName) ?? null,
    });
    const plan = computed.plan;
    legacyDocumentNames += before.legacyDocumentName;
    legacyItemTypes += before.legacyItemTypes;
    legacySourceKeys += before.legacySourceKeys;
    plannedLegacyDocumentNames += plan.after.legacyDocumentName;
    plannedLegacyItemTypes += plan.after.legacyItemTypes;
    plannedLegacySourceKeys += plan.after.legacySourceKeys;
    affected.push({
      ...plan,
      pendingUpdates: updates.length,
      lastUpdatedAt: new Date(row.updated_at).toISOString(),
    });
  }

  const ydocOpaqueBoardItemIds = [...opaqueBoardItemIds].sort();
  const targetCollisions = affected.filter((entry) => entry.targetCollision);
  const opaqueAllowlist = targetCollisions.map((entry) =>
    `runbook:${entry.sourceDocumentName.slice("board:runbook:".length)}`
  ).sort();
  const committedAllowlist = JSON.parse(await readFile(
    new URL("./ydoc-runbook-opaque-board-item-allowlist.json", import.meta.url),
    "utf8",
  )) as unknown;
  if (!Array.isArray(committedAllowlist) ||
    !committedAllowlist.every((value) => typeof value === "string")) {
    throw new Error("opaque board item allowlist must be a JSON string array");
  }
  const opaqueAllowlistMatches = sameStrings(opaqueAllowlist, committedAllowlist);
  const report = {
    mode: apply ? "apply" : "dry-run",
    writesEnabled: apply,
    documentsScanned: inventory.documents.length,
    pendingUpdatesApplied: inventory.updates.length,
    affectedDocuments: affected.length,
    legacyDocumentNames,
    legacyItemTypes,
    legacySourceKeys,
    plannedAfter: {
      legacyDocumentNames: plannedLegacyDocumentNames,
      legacyItemTypes: plannedLegacyItemTypes,
      legacySourceKeys: plannedLegacySourceKeys,
    },
    targetCollisions: targetCollisions.map((entry) => ({
      sourceDocumentName: entry.sourceDocumentName,
      canonicalDocumentName: entry.canonicalDocumentName,
      equivalent: entry.targetEquivalent,
      collisionContentHash: entry.collisionContentHash,
      planFingerprint: entry.planFingerprint,
    })),
    collisionPolicy: "non-equivalent targets require an explicitly approved content hash",
    opaqueBoardItemIds: opaqueAllowlist,
    opaqueAllowlistMatches,
    ydocOpaqueBoardItemIdCount: ydocOpaqueBoardItemIds.length,
    ...(!summaryOnly ? { ydocOpaqueBoardItemIds } : {}),
    projection: inventory.projection,
    ...(!summaryOnly ? { documents: affected } : {}),
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

  if (!apply) {
    process.stdout.write(
      "Dry run only. Apply requires explicit approval, stopped orch, --apply --quiesced " +
        "--orch-health-url=http://127.0.0.1:5200/api/health.\n",
    );
  } else {
    assertSameStrings(opaqueAllowlist, committedAllowlist);
    const approvedCollisionHashes = await loadApprovedCollisionHashes(
      approvedCollisionHashesPath,
    );
    const missingApprovals = targetCollisions
      .filter((entry) => entry.targetEquivalent === false)
      .map((entry) => entry.collisionContentHash)
      .filter((hash): hash is string => hash !== null && !approvedCollisionHashes.has(hash));
    if (missingApprovals.length > 0) {
      throw new Error(
        `non-equivalent collision hashes require approval: ${JSON.stringify(missingApprovals)}`,
      );
    }
    for (const entry of affected) {
      const result = await executeQuiescedBoardYjsRunbookMigration({
        request: {
          documentName: entry.sourceDocumentName,
          planFingerprint: entry.planFingerprint,
          opaqueBoardItemIds: entry.opaqueBoardItemIds,
          approvedCollisionContentHash: entry.targetEquivalent === false
            ? entry.collisionContentHash
            : null,
        },
        repository,
      });
      process.stdout.write(`${JSON.stringify({
        ok: true,
        sourceDocumentName: result.sourceDocumentName,
        canonicalDocumentName: result.canonicalDocumentName,
        attempts: result.attempts,
      })}\n`);
    }
  }
} finally {
  await sql.end();
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function readOption(name: string): string | null {
  const inline = process.argv.find((value) => value.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

async function loadApprovedCollisionHashes(path: string | null): Promise<Set<string>> {
  if (!path) return new Set();
  const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (!Array.isArray(parsed) ||
    !parsed.every((value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value))) {
    throw new Error("approved collision hashes must be a JSON array of SHA-256 strings");
  }
  return new Set(parsed);
}

function assertSameStrings(actual: readonly string[], expected: readonly string[]): void {
  const left = [...actual].sort();
  const right = [...expected].sort();
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    throw new Error(
      `opaque board item allowlist mismatch: expected ${JSON.stringify(right)}, ` +
        `received ${JSON.stringify(left)}`,
    );
  }
}

function sameStrings(actual: readonly string[], expected: readonly string[]): boolean {
  return JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());
}
