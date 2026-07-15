import { Buffer } from "node:buffer";

import { BoardYjsSqlResolver, type BoardYjsQuerySql } from "../board-yjs/board_yjs_sql.js";
import {
  assertDatabaseMutationVersion,
  commitPageMutationInTransaction,
} from "../page/page_repository.js";
import { getPageYjsDocumentName } from "../page/page_yjs_model.js";
import type { LiveDbSqlResolver } from "../runtime/live_db_sql.js";
import type {
  FolderProjectBinding,
  FolderProjectIdentityMutationResult,
  FolderProjectIdentityRepository,
  FolderProjectRecord,
  LegacyFolderBackfillResult,
  LegacyProjectFolder,
} from "./folder_project_identity_contracts.js";

type OperationRow = Record<string, unknown> & {
  id: string;
  folder_id: string;
  idempotency_key: string;
  payload_json: Record<string, unknown>;
};

export class SqlFolderProjectIdentityRepository implements FolderProjectIdentityRepository {
  private readonly sqlResolver: BoardYjsSqlResolver;

  constructor(resolver: LiveDbSqlResolver) {
    this.sqlResolver = new BoardYjsSqlResolver(resolver);
  }

  async findMutationByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<FolderProjectIdentityMutationResult | null> {
    const sql = await this.sqlResolver.resolveSql();
    const operation = await findOperation(sql, idempotencyKey);
    return operation ? await readResult(sql, operation, true) : null;
  }

  async create(
    input: Parameters<FolderProjectIdentityRepository["create"]>[0],
  ): Promise<FolderProjectIdentityMutationResult> {
    const sql = await this.sqlResolver.resolveSql();
    return await sql.begin(async (transaction) => {
      await lock(transaction, input.id);
      const existing = await findOperation(transaction, input.idempotencyKey);
      if (existing) return await readResult(transaction, existing, true);
      await assertParent(transaction, input.parentFolderId);
      const collisions = await transaction<readonly { folder_exists: boolean; page_exists: boolean }[]>`
        SELECT
          EXISTS(SELECT 1 FROM folders WHERE id = ${input.id}) AS folder_exists,
          EXISTS(SELECT 1 FROM pages WHERE id = ${input.pageId}) AS page_exists
      `;
      if (collisions[0]?.folder_exists || collisions[0]?.page_exists) {
        throw new Error(`folder project identity already exists: ${input.id}`);
      }
      const pageCommit = await commitPage(transaction, input);
      await transaction`
        INSERT INTO folders (
          id, name, sort_order, settings, parent_folder_id, project_page_id, archived
        ) VALUES (
          ${input.id}, ${input.name}, ${input.sortOrder}, ${transaction.json(input.settings)}::jsonb,
          ${input.parentFolderId}, ${input.pageId}, FALSE
        )
      `;
      const operation = await insertOperation(transaction, {
        id: input.operationId,
        folderId: input.id,
        operationType: "create_folder_project",
        actor: input.actor,
        idempotencyKey: input.idempotencyKey,
        payload: { page_id: input.pageId, page_operation_id: pageCommit.operation.id },
        reason: "create folder project identity",
      });
      return await readResult(transaction, operation, false, pageCommit);
    });
  }

  async mutate(
    input: Parameters<FolderProjectIdentityRepository["mutate"]>[0],
  ): Promise<FolderProjectIdentityMutationResult> {
    const sql = await this.sqlResolver.resolveSql();
    return await sql.begin(async (transaction) => {
      await lock(transaction, input.binding.folderId);
      const existing = await findOperation(transaction, input.idempotencyKey);
      if (existing) return await readResult(transaction, existing, true);
      const locked = await bindingRows(transaction, "folder", input.binding.folderId, true);
      if (!locked[0] || locked[0].pageId !== input.binding.pageId) {
        throw new Error(`folder project identity mapping changed: ${input.binding.folderId}`);
      }
      if (hasOwn(input.update, "parentFolderId")) {
        await assertParent(transaction, input.update.parentFolderId ?? null);
      }
      const pageCommit = await commitPage(transaction, input);
      const hasSortOrder = typeof input.update.sortOrder === "number";
      const hasSettings = input.update.settings !== undefined && input.update.settings !== null;
      const hasParent = hasOwn(input.update, "parentFolderId");
      await transaction`
        UPDATE folders
        SET name = ${input.title},
            archived = ${input.archived},
            sort_order = CASE WHEN ${hasSortOrder} THEN ${input.update.sortOrder ?? 0} ELSE sort_order END,
            settings = CASE WHEN ${hasSettings}
              THEN ${transaction.json(input.update.settings ?? {})}::jsonb ELSE settings END,
            parent_folder_id = CASE WHEN ${hasParent}
              THEN ${input.update.parentFolderId ?? null} ELSE parent_folder_id END
        WHERE id = ${input.binding.folderId}
          AND project_page_id = ${input.binding.pageId}
      `;
      if (input.archived && !input.binding.archived) {
        await cleanupArchivedFolder(transaction, input.binding.folderId);
      }
      const operationType = input.archived !== input.binding.archived
        ? input.archived ? "archive_folder_project" : "unarchive_folder_project"
        : "update_folder_project";
      const operation = await insertOperation(transaction, {
        id: input.operationId,
        folderId: input.binding.folderId,
        operationType,
        actor: input.actor,
        idempotencyKey: input.idempotencyKey,
        payload: {
          page_id: input.binding.pageId,
          page_operation_id: pageCommit.operation.id,
          title: input.title,
          archived: input.archived,
        },
        reason: input.pageApplication.reason ?? "mutate folder project identity",
      });
      return await readResult(transaction, operation, false, pageCommit);
    });
  }

  async findByFolderId(folderId: string): Promise<FolderProjectBinding | null> {
    const sql = await this.sqlResolver.resolveSql();
    return (await bindingRows(sql, "folder", folderId))[0] ?? null;
  }

  async findByPageId(pageId: string): Promise<FolderProjectBinding | null> {
    const sql = await this.sqlResolver.resolveSql();
    return (await bindingRows(sql, "page", pageId))[0] ?? null;
  }

  async readPageSnapshot(pageId: string): Promise<Uint8Array | null> {
    const sql = await this.sqlResolver.resolveSql();
    const rows = await sql<readonly { snapshot: Buffer | Uint8Array }[]>`
      SELECT snapshot FROM board_yjs_documents
      WHERE name = ${getPageYjsDocumentName(pageId)}
    `;
    return rows[0]?.snapshot ? new Uint8Array(rows[0].snapshot) : null;
  }

  async listLegacyFolders(): Promise<readonly LegacyProjectFolder[]> {
    const sql = await this.sqlResolver.resolveSql();
    const rows = await sql<readonly Record<string, unknown>[]>`
      SELECT id, name, sort_order, settings, parent_folder_id
      FROM folders
      WHERE project_page_id IS NULL AND archived = FALSE
        AND id NOT IN ('claude', 'llm')
      ORDER BY sort_order, name, id
    `;
    return rows.flatMap(legacyFolder);
  }

  async bindLegacyPage(
    input: Parameters<FolderProjectIdentityRepository["bindLegacyPage"]>[0],
  ): Promise<LegacyFolderBackfillResult> {
    return await this.persistBackfill(input, false);
  }

  async createLegacyPageAndBind(
    input: Parameters<FolderProjectIdentityRepository["createLegacyPageAndBind"]>[0],
  ): Promise<LegacyFolderBackfillResult> {
    return await this.persistBackfill(input, true);
  }

  private async persistBackfill(
    input: Parameters<FolderProjectIdentityRepository["bindLegacyPage"]>[0],
    createdPage: boolean,
  ): Promise<LegacyFolderBackfillResult> {
    const sql = await this.sqlResolver.resolveSql();
    return await sql.begin(async (transaction) => {
      await lock(transaction, input.folder.folderId);
      const existing = await findOperation(transaction, input.idempotencyKey);
      if (existing) return backfillResult(existing, true);
      await assertBackfillCandidate(transaction, input.folder, input.pageId, createdPage);
      const pageCommit = await commitPage(transaction, input);
      const updated = await transaction<readonly { id: string }[]>`
        UPDATE folders SET project_page_id = ${input.pageId}
        WHERE id = ${input.folder.folderId} AND project_page_id IS NULL
        RETURNING id
      `;
      if (!updated[0]) throw new Error(`legacy folder binding changed: ${input.folder.folderId}`);
      const operation = await insertOperation(transaction, {
        id: input.operationId,
        folderId: input.folder.folderId,
        operationType: "backfill_folder_project",
        actor: input.actor,
        idempotencyKey: input.idempotencyKey,
        payload: {
          page_id: input.pageId,
          created_page: createdPage,
          page_operation_id: pageCommit.operation.id,
        },
        reason: "backfill legacy folder project identity",
      });
      return { ...backfillResult(operation, false), pageCommit };
    });
  }
}

async function commitPage(
  sql: BoardYjsQuerySql,
  input: { pageId?: string; pageOperationId: string; pageApplication: Parameters<typeof commitPageMutationInTransaction>[1]["application"] },
) {
  const pageId = input.pageId ?? input.pageApplication.replica.page.id;
  const commitInput = {
    documentName: getPageYjsDocumentName(pageId),
    application: input.pageApplication,
    operationId: input.pageOperationId,
  };
  await assertDatabaseMutationVersion(sql, commitInput);
  return await commitPageMutationInTransaction(sql, commitInput);
}

async function lock(sql: BoardYjsQuerySql, id: string): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${id}, 0))`;
}

async function assertParent(sql: BoardYjsQuerySql, parentFolderId: string | null): Promise<void> {
  if (parentFolderId === null) return;
  const rows = await sql<readonly { exists: boolean }[]>`
    SELECT EXISTS(
      SELECT 1 FROM folders WHERE id = ${parentFolderId} AND archived = FALSE
    ) AS exists
  `;
  if (!rows[0]?.exists) throw new Error(`active parent folder not found: ${parentFolderId}`);
}

async function cleanupArchivedFolder(sql: BoardYjsQuerySql, folderId: string): Promise<void> {
  await sql`UPDATE sessions SET folder_id = NULL WHERE folder_id = ${folderId}`;
  await sql`UPDATE folders SET parent_folder_id = NULL WHERE parent_folder_id = ${folderId}`;
  await sql`DELETE FROM board_items WHERE folder_id = ${folderId}`;
  await sql`DELETE FROM board_items WHERE item_type = 'subfolder' AND item_id = ${folderId}`;
}

async function assertBackfillCandidate(
  sql: BoardYjsQuerySql,
  folder: LegacyProjectFolder,
  pageId: string,
  createdPage: boolean,
): Promise<void> {
  const folders = await sql<readonly { project_page_id: string | null }[]>`
    SELECT project_page_id FROM folders WHERE id = ${folder.folderId} FOR UPDATE
  `;
  if (!folders[0] || folders[0].project_page_id !== null) {
    throw new Error(`legacy folder is already bound: ${folder.folderId}`);
  }
  const pages = await sql<readonly {
    exists: boolean;
    daily: boolean;
    used_by_folder: boolean;
    used_by_runbook: boolean;
  }[]>`
    SELECT
      EXISTS(SELECT 1 FROM pages WHERE id = ${pageId}) AS exists,
      EXISTS(SELECT 1 FROM pages WHERE id = ${pageId} AND daily_date IS NOT NULL) AS daily,
      EXISTS(SELECT 1 FROM folders WHERE project_page_id = ${pageId}) AS used_by_folder,
      EXISTS(SELECT 1 FROM runbooks WHERE task_page_id = ${pageId}) AS used_by_runbook
  `;
  const page = pages[0];
  if (createdPage ? page?.exists : !page?.exists) {
    throw new Error(`legacy page existence conflict: ${pageId}`);
  }
  if (page?.daily || page?.used_by_folder || page?.used_by_runbook) {
    throw new Error(`legacy page is not available for folder binding: ${pageId}`);
  }
}

async function bindingRows(
  sql: BoardYjsQuerySql,
  by: "folder" | "page",
  id: string,
  forUpdate = false,
): Promise<FolderProjectBinding[]> {
  const rows = by === "folder"
    ? forUpdate
      ? await sql<readonly Record<string, unknown>[]>`
          SELECT f.id, f.name, f.sort_order, f.settings, f.parent_folder_id,
                 f.project_page_id, f.archived, p.version AS page_version
          FROM folders f JOIN pages p ON p.id = f.project_page_id
          WHERE f.id = ${id} FOR UPDATE OF f, p
        `
      : await sql<readonly Record<string, unknown>[]>`
          SELECT f.id, f.name, f.sort_order, f.settings, f.parent_folder_id,
                 f.project_page_id, f.archived, p.version AS page_version
          FROM folders f JOIN pages p ON p.id = f.project_page_id
          WHERE f.id = ${id}
        `
    : forUpdate
      ? await sql<readonly Record<string, unknown>[]>`
          SELECT f.id, f.name, f.sort_order, f.settings, f.parent_folder_id,
                 f.project_page_id, f.archived, p.version AS page_version
          FROM folders f JOIN pages p ON p.id = f.project_page_id
          WHERE f.project_page_id = ${id} FOR UPDATE OF f, p
        `
      : await sql<readonly Record<string, unknown>[]>`
          SELECT f.id, f.name, f.sort_order, f.settings, f.parent_folder_id,
                 f.project_page_id, f.archived, p.version AS page_version
          FROM folders f JOIN pages p ON p.id = f.project_page_id
          WHERE f.project_page_id = ${id}
        `;
  return rows.flatMap(bindingRow);
}

function bindingRow(row: Record<string, unknown>): FolderProjectBinding[] {
  const folder = folderRow(row);
  const pageId = stringValue(row.project_page_id);
  if (!folder || !pageId) return [];
  return [{
    ...folder,
    folderId: folder.id,
    pageId,
    archived: Boolean(row.archived),
    pageVersion: Number(row.page_version),
  }];
}

function folderRow(row: Record<string, unknown>): FolderProjectRecord | null {
  const id = stringValue(row.id);
  const pageId = stringValue(row.project_page_id);
  if (!id || !pageId) return null;
  return {
    id,
    name: String(row.name ?? ""),
    sortOrder: Number(row.sort_order ?? 0),
    settings: recordValue(row.settings),
    parentFolderId: stringValue(row.parent_folder_id),
    projectPageId: pageId,
  };
}

function legacyFolder(row: Record<string, unknown>): LegacyProjectFolder[] {
  const folderId = stringValue(row.id);
  if (!folderId) return [];
  return [{
    folderId,
    name: String(row.name ?? ""),
    sortOrder: Number(row.sort_order ?? 0),
    settings: recordValue(row.settings),
    parentFolderId: stringValue(row.parent_folder_id),
  }];
}

async function findOperation(
  sql: BoardYjsQuerySql,
  idempotencyKey: string,
): Promise<OperationRow | null> {
  const rows = await sql<readonly OperationRow[]>`
    SELECT * FROM folder_project_operations WHERE idempotency_key = ${idempotencyKey}
  `;
  return rows[0] ?? null;
}

async function insertOperation(
  sql: BoardYjsQuerySql,
  input: {
    id: string;
    folderId: string;
    operationType: string;
    actor: { actorKind: string; actorSessionId?: string | null; actorUserId?: string | null };
    idempotencyKey: string;
    payload: Record<string, unknown>;
    reason: string | null;
  },
): Promise<OperationRow> {
  const rows = await sql<readonly OperationRow[]>`
    INSERT INTO folder_project_operations (
      id, folder_id, operation_type, actor_kind, actor_session_id, actor_user_id,
      idempotency_key, payload_json, reason
    ) VALUES (
      ${input.id}, ${input.folderId}, ${input.operationType}, ${input.actor.actorKind},
      ${input.actor.actorSessionId ?? null}, ${input.actor.actorUserId ?? null},
      ${input.idempotencyKey}, ${sql.json(input.payload)}::jsonb, ${input.reason}
    ) RETURNING *
  `;
  if (!rows[0]) throw new Error("folder project operation insert returned no row");
  return rows[0];
}

async function readResult(
  sql: BoardYjsQuerySql,
  operation: OperationRow,
  idempotent: boolean,
  pageCommit?: FolderProjectIdentityMutationResult["pageCommit"],
): Promise<FolderProjectIdentityMutationResult> {
  const binding = (await bindingRows(sql, "folder", operation.folder_id))[0];
  if (!binding) throw new Error(`folder project identity not found: ${operation.folder_id}`);
  const resolvedCommit = pageCommit ?? await pageCommitFromOperation(sql, operation);
  return {
    id: binding.folderId,
    pageId: binding.pageId,
    folder: binding,
    operation,
    pageCommit: resolvedCommit,
    idempotent,
  };
}

async function pageCommitFromOperation(sql: BoardYjsQuerySql, operation: OperationRow) {
  const operationId = stringValue(operation.payload_json?.page_operation_id);
  if (!operationId) throw new Error(`folder operation has no page operation: ${operation.id}`);
  const rows = await sql<readonly Record<string, unknown>[]>`
    SELECT * FROM page_operations WHERE id = ${operationId}
  `;
  const pageOperation = rows[0];
  if (!pageOperation) throw new Error(`page operation not found: ${operationId}`);
  const pageId = String(pageOperation.page_id);
  const timestamps = await sql<readonly { created_at: Date; updated_at: Date }[]>`
    SELECT created_at, updated_at FROM pages WHERE id = ${pageId}
  `;
  if (!timestamps[0]) throw new Error(`page not found: ${pageId}`);
  return {
    operation: pageOperation as FolderProjectIdentityMutationResult["pageCommit"]["operation"],
    pageCreatedAt: timestamps[0].created_at,
    pageUpdatedAt: timestamps[0].updated_at,
    idempotent: true,
  };
}

function backfillResult(operation: OperationRow, idempotent: boolean): LegacyFolderBackfillResult {
  return {
    folderId: operation.folder_id,
    pageId: String(operation.payload_json.page_id),
    createdPage: operation.payload_json.created_page === true,
    operation,
    idempotent,
  };
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function recordValue(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}
