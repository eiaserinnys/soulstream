import { reconcileFolderParentMounts } from "./folder_parent_mounts.js";
import { isDeepStrictEqual } from "node:util";
import { appendFolderOperation } from "./folder_operation_store.js";
import { syncBoardYjsReplicaWithSql } from "../board-yjs/board_yjs_replica_sync.js";
import { storePageDocument } from "../page/page_repository_projection.js";
import { ChecklistVersionConflict } from "../checklist/control_plane/checklist_models.js";
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
    request: Record<string, unknown>,
  ): Promise<FolderProjectIdentityMutationResult | null> {
    const sql = await this.sqlResolver.resolveSql();
    const operation = await findOperation(sql, idempotencyKey);
    if (!operation) return null;
    assertSameRequest(operation, request);
    return await readResult(sql, operation, true);
  }

  async create(
    input: Parameters<FolderProjectIdentityRepository["create"]>[0],
  ): Promise<FolderProjectIdentityMutationResult> {
    const sql = await this.sqlResolver.resolveSql();
    return await sql.begin(async (transaction) => {
      await lock(transaction, input.id);
      const existing = await findOperation(transaction, input.idempotencyKey);
      if (existing) {
        assertSameRequest(existing, input.request);
        return await readResult(transaction, existing, true);
      }
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
          id, name, sort_order, settings, parent_folder_id, project_page_id, archived, checklist_enabled, created_session_id, created_event_id
        ) VALUES (
          ${input.id}, ${input.name}, ${input.sortOrder}, ${transaction.json(input.settings)}::jsonb,
          ${input.parentFolderId}, ${input.pageId}, FALSE, ${input.checklistEnabled},
          ${input.actor.actorSessionId ?? null}, ${pageCommit.operation.actor_event_id ?? null}
        )
      `;
      for (const application of input.boardApplications ?? []) {
        await storePageDocument(transaction, application.documentName, application.snapshot);
        await syncBoardYjsReplicaWithSql(transaction, application.scope, application.replica, application.documentName);
      }
      const mounts = await reconcileFolderParentMounts(transaction, {
        pageId: input.pageId, title: input.name, previousParentFolderId: null,
        parentFolderId: input.parentFolderId, actor: input.actor, idempotencyKey: input.idempotencyKey,
      });
      const operation = await insertOperation(transaction, {
        id: input.operationId,
        folderId: input.id,
        operationType: "create_folder",
        actor: input.actor,
        idempotencyKey: input.idempotencyKey,
        payload: { request: input.request, page_id: input.pageId, page_operation_id: pageCommit.operation.id },
        reason: "create folder project identity",
      });
      return { ...await readResult(transaction, operation, false, pageCommit), parentPageUpdates: mounts.updates };
    });
  }

  async mutate(
    input: Parameters<FolderProjectIdentityRepository["mutate"]>[0],
  ): Promise<FolderProjectIdentityMutationResult> {
    const sql = await this.sqlResolver.resolveSql();
    return await sql.begin(async (transaction) => {
      await lock(transaction, input.binding.folderId);
      const existing = await findOperation(transaction, input.idempotencyKey);
      if (existing) {
        assertSameRequest(existing, input.request);
        return await readResult(transaction, existing, true);
      }
      const locked = await bindingRows(transaction, "folder", input.binding.folderId, true);
      if (!locked[0] || locked[0].pageId !== input.binding.pageId) {
        throw new Error(`folder project identity mapping changed: ${input.binding.folderId}`);
      }
      if (locked[0].version !== input.expectedVersion) {
        throw new ChecklistVersionConflict("folder", input.binding.folderId, input.expectedVersion, locked[0].version);
      }
      if (hasOwn(input.update, "parentFolderId")) {
        await assertParent(transaction, input.update.parentFolderId ?? null, input.binding.folderId);
      }
      const pageCommit = await commitPage(transaction, input);
      const hasSortOrder = typeof input.update.sortOrder === "number";
      const hasSettings = input.update.settings !== undefined && input.update.settings !== null;
      const hasParent = hasOwn(input.update, "parentFolderId");
      await transaction`
        UPDATE folders
        SET name = ${input.title},
            version = version + 1, updated_at = NOW(),
            archived = ${input.archived},
            sort_order = CASE WHEN ${hasSortOrder} THEN ${input.update.sortOrder ?? 0} ELSE sort_order END,
            settings = CASE WHEN ${hasSettings}
              THEN ${transaction.json(input.update.settings ?? {})}::jsonb ELSE settings END,
            parent_folder_id = CASE WHEN ${hasParent}
              THEN ${input.update.parentFolderId ?? null} ELSE parent_folder_id END
        WHERE id = ${input.binding.folderId}
          AND project_page_id = ${input.binding.pageId}
      `;

      for (const application of input.boardApplications ?? []) {
        await storePageDocument(transaction, application.documentName, application.snapshot);
        await syncBoardYjsReplicaWithSql(transaction, application.scope, application.replica, application.documentName);
      }
      const parentFolderId = hasParent ? input.update.parentFolderId ?? null : input.binding.parentFolderId;
      const mounts = parentFolderId !== input.binding.parentFolderId
        ? await reconcileFolderParentMounts(transaction, {
          pageId: input.binding.pageId, title: input.title, previousParentFolderId: input.binding.parentFolderId,
          parentFolderId, actor: input.actor, idempotencyKey: input.idempotencyKey,
        }) : { updates: [] };
      const operationType = input.archived !== input.binding.archived
        ? input.archived ? "archive_folder" : "unarchive_folder"
        : "update_folder";
      const operation = await insertOperation(transaction, {
        id: input.operationId,
        folderId: input.binding.folderId,
        operationType,
        actor: input.actor,
        idempotencyKey: input.idempotencyKey,
        payload: {
          request: input.request,
          page_id: input.binding.pageId,
          page_operation_id: pageCommit.operation.id,
          title: input.title,
          archived: input.archived,
        },
        reason: input.pageApplication.reason ?? "mutate folder project identity",
      });
      return { ...await readResult(transaction, operation, false, pageCommit), parentPageUpdates: mounts.updates };
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

async function assertParent(sql: BoardYjsQuerySql, parentFolderId: string | null, folderId?: string): Promise<void> {
  if (parentFolderId === null) return;
  const rows = await sql<readonly { exists: boolean }[]>`
    SELECT EXISTS(
      SELECT 1 FROM folders WHERE id = ${parentFolderId} AND archived = FALSE
    ) AS exists
  `;
  if (!rows[0]?.exists) throw new Error(`active parent folder not found: ${parentFolderId}`);
  if (folderId) {
    const ancestors = await sql<readonly { id: string }[]>`WITH RECURSIVE ancestors AS (
      SELECT id, parent_folder_id FROM folders WHERE id = ${parentFolderId}
      UNION SELECT f.id, f.parent_folder_id FROM folders f JOIN ancestors a ON a.parent_folder_id = f.id
    ) SELECT id FROM ancestors WHERE id = ${folderId}`;
    if (ancestors.length) throw Object.assign(new Error("folder parent cycle"), { statusCode: 422, code: "FOLDER_PARENT_CYCLE" });
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
          SELECT f.*, p.version AS page_version
          FROM folders f JOIN pages p ON p.id = f.project_page_id
          WHERE f.id = ${id} FOR UPDATE OF f, p
        `
      : await sql<readonly Record<string, unknown>[]>`
          SELECT f.*, p.version AS page_version
          FROM folders f JOIN pages p ON p.id = f.project_page_id
          WHERE f.id = ${id}
        `
    : forUpdate
      ? await sql<readonly Record<string, unknown>[]>`
          SELECT f.*, p.version AS page_version
          FROM folders f JOIN pages p ON p.id = f.project_page_id
          WHERE f.project_page_id = ${id} FOR UPDATE OF f, p
        `
      : await sql<readonly Record<string, unknown>[]>`
          SELECT f.*, p.version AS page_version
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
    archived: Boolean(row.archived),
    checklistEnabled: Boolean(row.checklist_enabled),
    status: row.status as "open" | "completed",
    version: Number(row.version),
    createdSessionId: stringValue(row.created_session_id),
    createdEventId: row.created_event_id === null ? null : Number(row.created_event_id),
    createdAt: new Date(row.created_at as string | Date).toISOString(),
    updatedAt: new Date(row.updated_at as string | Date).toISOString(),
    completedKind: stringValue(row.completed_kind),
    completedSessionId: stringValue(row.completed_session_id),
    completedEventId: row.completed_event_id === null ? null : Number(row.completed_event_id),
    completedUserId: stringValue(row.completed_user_id),
    completedAt: row.completed_at ? new Date(row.completed_at as string | Date).toISOString() : null,
  };
}

async function findOperation(
  sql: BoardYjsQuerySql,
  idempotencyKey: string,
): Promise<OperationRow | null> {
  const rows = await sql<readonly OperationRow[]>`
    SELECT * FROM folder_operations WHERE idempotency_key = ${idempotencyKey}
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
  const operation = await appendFolderOperation(sql, {
    ...input, targetKind: "folder", targetId: input.folderId,
    actorKind: input.actor.actorKind as import("../checklist/control_plane/checklist_types.js").FolderOperationActorKind,
    actorSessionId: input.actor.actorSessionId, actorUserId: input.actor.actorUserId, actorEventId: null,
  });
  return operation as OperationRow;
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
    SELECT * FROM block_operations WHERE id = ${operationId}
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

function assertSameRequest(operation: OperationRow, request: Record<string, unknown>): void {
  if (!isDeepStrictEqual(operation.payload_json.request, request)) {
    throw Object.assign(new Error("Idempotency key belongs to a different folder request"), { statusCode: 409, code: "FOLDER_IDEMPOTENCY_CONFLICT" });
  }
}
