import { Buffer } from "node:buffer";

import {
  syncBoardYjsReplicaWithSql,
} from "../board-yjs/board_yjs_repository.js";
import {
  BoardYjsSqlResolver,
  type BoardYjsQuerySql,
} from "../board-yjs/board_yjs_sql.js";
import {
  assertDatabaseMutationVersion,
  commitPageMutationInTransaction,
} from "../page/page_repository.js";
import { getPageYjsDocumentName } from "../page/page_yjs_model.js";
import type { LiveDbSqlResolver } from "../runtime/live_db_sql.js";
import type {
  LegacyRunbookBackfillResult,
  LegacyRunbookBinding,
  RunbookTaskIdentityMutationResult,
  RunbookTaskIdentityRepository,
  TaskIdentityBinding,
} from "./runbook_task_identity_service.js";
import { bindingRows, legacyBindingRows } from "./runbook_task_identity_queries.js";
import {
  appendRunbookEvent,
  findOperation,
  insertRunbookOperation,
  legacyBackfillResult,
  operationRunbookId,
  readResult,
  storeBoardApplication,
} from "./runbook_task_identity_operation_store.js";

export class SqlRunbookTaskIdentityRepository implements RunbookTaskIdentityRepository {
  private readonly sqlResolver: BoardYjsSqlResolver;

  constructor(resolver: LiveDbSqlResolver) {
    this.sqlResolver = new BoardYjsSqlResolver(resolver);
  }

  async findMutationByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<RunbookTaskIdentityMutationResult | null> {
    const sql = await this.sqlResolver.resolveSql();
    const operation = await findOperation(sql, idempotencyKey);
    if (!operation) return null;
    const runbookId = operationRunbookId(operation);
    return await readResult(sql, runbookId, operation, true);
  }

  async findLegacyBackfillByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<LegacyRunbookBackfillResult | null> {
    const sql = await this.sqlResolver.resolveSql();
    const operation = await findOperation(sql, idempotencyKey);
    if (!operation) return null;
    if (operation.operation_type !== "backfill_task_identity") {
      throw new Error(`idempotency key belongs to ${String(operation.operation_type)}`);
    }
    return legacyBackfillResult(operation, true);
  }

  async create(
    input: Parameters<RunbookTaskIdentityRepository["create"]>[0],
  ): Promise<RunbookTaskIdentityMutationResult> {
    const sql = await this.sqlResolver.resolveSql();
    return await sql.begin(async (transaction) => {
      await transaction`SELECT pg_advisory_xact_lock(hashtextextended(${input.id}, 0))`;
      const existing = await findOperation(transaction, input.idempotencyKey);
      if (existing) return await readResult(transaction, input.id, existing, true);

      const collisions = await transaction<readonly { runbook_exists: boolean; page_exists: boolean }[]>`
        SELECT
          EXISTS(SELECT 1 FROM runbooks WHERE id = ${input.runbookId}) AS runbook_exists,
          EXISTS(SELECT 1 FROM pages WHERE id = ${input.pageId}) AS page_exists
      `;
      if (collisions[0]?.runbook_exists || collisions[0]?.page_exists) {
        throw new Error(`task identity already exists: ${input.id}`);
      }

      await transaction`
        INSERT INTO board_yjs_documents (name, snapshot, updated_at)
        VALUES (
          ${input.boardApplication.documentName},
          ${Buffer.from(input.boardApplication.snapshot)},
          NOW()
        )
        ON CONFLICT (name) DO UPDATE
        SET snapshot = EXCLUDED.snapshot,
            updated_at = EXCLUDED.updated_at
      `;
      await syncBoardYjsReplicaWithSql(
        transaction,
        input.boardApplication.scope,
        input.boardApplication.replica,
        input.boardApplication.documentName,
      );

      const pageCommitInput = {
        documentName: getPageYjsDocumentName(input.pageId),
        application: input.pageApplication,
        operationId: input.pageOperationId,
      };
      await assertDatabaseMutationVersion(transaction, pageCommitInput);
      const pageCommit = await commitPageMutationInTransaction(transaction, pageCommitInput);
      const eventId = await appendRunbookEvent(transaction, {
        actor: input.actor,
        operationId: input.operationId,
        operationType: "create_runbook",
        runbookId: input.runbookId,
        idempotencyKey: input.idempotencyKey,
      });
      const runbookRows = await transaction<readonly Record<string, unknown>[]>`
        INSERT INTO runbooks (
          id, board_item_id, task_page_id, title, created_session_id, created_event_id
        ) VALUES (
          ${input.runbookId}, ${input.boardItemId}, ${input.taskPageId}, ${input.title},
          ${input.actor.actorSessionId ?? null}, ${eventId}
        )
        RETURNING *
      `;
      if (!runbookRows[0]) throw new Error("task identity runbook insert returned no row");
      const operationRows = await transaction<readonly Record<string, unknown>[]>`
        INSERT INTO runbook_operations (
          id, runbook_id, target_kind, target_id, operation_type,
          actor_kind, actor_session_id, actor_event_id, actor_user_id,
          idempotency_key, payload_json, reason
        ) VALUES (
          ${input.operationId}, ${input.runbookId}, ${"runbook"}, ${input.runbookId},
          ${"create_runbook"}, ${input.actor.actorKind},
          ${input.actor.actorSessionId ?? null}, ${eventId},
          ${input.actor.actorUserId ?? null}, ${input.idempotencyKey},
          ${transaction.json({
            id: input.id,
            page_id: input.pageId,
            board_item_id: input.boardItemId,
            folder_id: input.folderId,
            title: input.title,
            page_operation_id: pageCommit.operation.id,
          })}::jsonb,
          ${"create runbook task identity"}
        )
        RETURNING *
      `;
      const operation = operationRows[0];
      if (!operation) throw new Error("task identity operation insert returned no row");
      return await readResult(transaction, input.id, operation, false, pageCommit);
    });
  }

  async promote(
    input: Parameters<RunbookTaskIdentityRepository["promote"]>[0],
  ): Promise<RunbookTaskIdentityMutationResult> {
    const sql = await this.sqlResolver.resolveSql();
    return await sql.begin(async (transaction) => {
      await transaction`SELECT pg_advisory_xact_lock(hashtextextended(${input.id}, 0))`;
      const existing = await findOperation(transaction, input.idempotencyKey);
      if (existing) return await readResult(transaction, input.runbookId, existing, true);

      const collisions = await transaction<readonly { runbook_exists: boolean; page_exists: boolean }[]>`
        SELECT
          EXISTS(SELECT 1 FROM runbooks WHERE id = ${input.runbookId}) AS runbook_exists,
          EXISTS(SELECT 1 FROM pages WHERE id = ${input.pageId}) AS page_exists
      `;
      if (collisions[0]?.runbook_exists) {
        throw new Error(`task identity runbook already exists: ${input.runbookId}`);
      }
      if (!collisions[0]?.page_exists) {
        throw new Error(`task identity source page not found: ${input.pageId}`);
      }

      await storeBoardApplication(transaction, input.boardApplication);
      const pageCommitInput = {
        documentName: getPageYjsDocumentName(input.pageId),
        application: input.pageApplication,
        operationId: input.pageOperationId,
      };
      await assertDatabaseMutationVersion(transaction, pageCommitInput);
      const pageCommit = await commitPageMutationInTransaction(transaction, pageCommitInput);
      const eventId = await appendRunbookEvent(transaction, {
        actor: input.actor,
        operationId: input.operationId,
        operationType: "create_runbook",
        runbookId: input.runbookId,
        idempotencyKey: input.idempotencyKey,
      });
      await transaction`
        INSERT INTO runbooks (
          id, board_item_id, task_page_id, title, archived,
          created_session_id, created_event_id
        ) VALUES (
          ${input.runbookId}, ${input.boardItemId}, ${input.taskPageId}, ${input.title},
          ${input.pageApplication.replica.page.archived},
          ${input.actor.actorSessionId ?? null}, ${eventId}
        )
      `;
      const operation = await insertRunbookOperation(transaction, {
        id: input.operationId,
        runbookId: input.runbookId,
        operationType: "create_runbook",
        actor: input.actor,
        eventId,
        idempotencyKey: input.idempotencyKey,
        payload: {
          id: input.id,
          page_id: input.pageId,
          board_item_id: input.boardItemId,
          folder_id: input.folderId,
          title: input.title,
          promoted_existing_page: true,
          page_operation_id: pageCommit.operation.id,
        },
        reason: "promote page to runbook task identity",
      });
      return await readResult(transaction, input.runbookId, operation, false, pageCommit);
    });
  }

  async mutate(
    input: Parameters<RunbookTaskIdentityRepository["mutate"]>[0],
  ): Promise<RunbookTaskIdentityMutationResult> {
    const sql = await this.sqlResolver.resolveSql();
    return await sql.begin(async (transaction) => {
      await transaction`SELECT pg_advisory_xact_lock(hashtextextended(${input.binding.runbookId}, 0))`;
      const existing = await findOperation(transaction, input.idempotencyKey);
      if (existing) {
        return await readResult(transaction, input.binding.runbookId, existing, true);
      }
      const bindings = await bindingRows(transaction, "runbook", input.binding.runbookId, true);
      const locked = bindings[0];
      if (!locked || locked.pageId !== input.binding.pageId) {
        throw new Error(`task identity mapping changed: ${input.binding.runbookId}`);
      }
      if (locked.runbookVersion !== input.expectedRunbookVersion) {
        throw new Error(
          `runbook version conflict: ${input.binding.runbookId} expected ${input.expectedRunbookVersion}, actual ${locked.runbookVersion}`,
        );
      }
      await storeBoardApplication(transaction, input.boardApplication);
      const pageCommitInput = {
        documentName: getPageYjsDocumentName(input.binding.pageId),
        application: input.pageApplication,
        operationId: input.pageOperationId,
      };
      await assertDatabaseMutationVersion(transaction, pageCommitInput);
      const pageCommit = await commitPageMutationInTransaction(transaction, pageCommitInput);
      const eventId = await appendRunbookEvent(transaction, {
        actor: input.actor,
        operationId: input.operationId,
        operationType: input.operationType,
        runbookId: input.binding.runbookId,
        idempotencyKey: input.idempotencyKey,
      });
      const updated = await transaction<readonly Record<string, unknown>[]>`
        UPDATE runbooks
        SET title = ${input.title}, archived = ${input.archived},
            version = version + 1, updated_at = NOW()
        WHERE id = ${input.binding.runbookId}
          AND version = ${input.expectedRunbookVersion}
        RETURNING *
      `;
      if (!updated[0]) {
        throw new Error(`runbook version conflict: ${input.binding.runbookId}`);
      }
      const operation = await insertRunbookOperation(transaction, {
        id: input.operationId,
        runbookId: input.binding.runbookId,
        operationType: input.operationType,
        actor: input.actor,
        eventId,
        idempotencyKey: input.idempotencyKey,
        payload: {
          title: input.title,
          archived: input.archived,
          page_id: input.binding.pageId,
          page_operation_id: pageCommit.operation.id,
        },
        reason: input.pageApplication.reason ?? "mutate runbook task identity",
      });
      return await readResult(
        transaction,
        input.binding.runbookId,
        operation,
        false,
        pageCommit,
      );
    });
  }

  async findLegacyRunbook(runbookId: string): Promise<LegacyRunbookBinding | null> {
    const sql = await this.sqlResolver.resolveSql();
    const rows = await legacyBindingRows(sql, runbookId);
    return rows[0] ?? null;
  }

  async bindLegacyPage(
    input: Parameters<RunbookTaskIdentityRepository["bindLegacyPage"]>[0],
  ): Promise<LegacyRunbookBackfillResult> {
    const sql = await this.sqlResolver.resolveSql();
    return await sql.begin(async (transaction) => {
      await transaction`SELECT pg_advisory_xact_lock(hashtextextended(${input.binding.runbookId}, 0))`;
      const existing = await findOperation(transaction, input.idempotencyKey);
      if (existing) {
        return legacyBackfillResult(existing, true);
      }
      await assertLegacyBinding(transaction, input.binding, input.pageId);
      const eventId = await appendRunbookEvent(transaction, {
        actor: input.actor,
        operationId: input.operationId,
        operationType: "update_runbook",
        runbookId: input.binding.runbookId,
        idempotencyKey: input.idempotencyKey,
      });
      const operation = await persistLegacyBinding(transaction, {
        ...input,
        eventId,
        createdPage: false,
      });
      return legacyBackfillResult(operation, false);
    });
  }

  async createLegacyPageAndBind(
    input: Parameters<RunbookTaskIdentityRepository["createLegacyPageAndBind"]>[0],
  ): Promise<LegacyRunbookBackfillResult> {
    const sql = await this.sqlResolver.resolveSql();
    return await sql.begin(async (transaction) => {
      await transaction`SELECT pg_advisory_xact_lock(hashtextextended(${input.binding.runbookId}, 0))`;
      const existing = await findOperation(transaction, input.idempotencyKey);
      if (existing) {
        return legacyBackfillResult(existing, true);
      }
      const pages = await transaction<readonly { exists: boolean }[]>`
        SELECT EXISTS(SELECT 1 FROM pages WHERE id = ${input.pageId}) AS exists
      `;
      if (pages[0]?.exists) throw new Error(`backfill page already exists: ${input.pageId}`);
      const pageCommitInput = {
        documentName: getPageYjsDocumentName(input.pageId),
        application: input.pageApplication,
        operationId: input.pageOperationId,
      };
      await assertDatabaseMutationVersion(transaction, pageCommitInput);
      const pageCommit = await commitPageMutationInTransaction(transaction, pageCommitInput);
      await assertLegacyBinding(transaction, input.binding, input.pageId);
      const eventId = await appendRunbookEvent(transaction, {
        actor: input.actor,
        operationId: input.operationId,
        operationType: "update_runbook",
        runbookId: input.binding.runbookId,
        idempotencyKey: input.idempotencyKey,
      });
      const operation = await persistLegacyBinding(transaction, {
        ...input,
        eventId,
        createdPage: true,
        pageOperationId: pageCommit.operation.id,
      });
      return {
        ...legacyBackfillResult(operation, false),
        pageCommit,
      };
    });
  }

  async findByPageId(pageId: string): Promise<TaskIdentityBinding | null> {
    return await this.findBinding("r.task_page_id", pageId);
  }

  async findByRunbookId(runbookId: string): Promise<TaskIdentityBinding | null> {
    return await this.findBinding("r.id", runbookId);
  }

  async readPageSnapshot(pageId: string): Promise<Uint8Array | null> {
    const sql = await this.sqlResolver.resolveSql();
    const rows = await sql<readonly { snapshot: Buffer | Uint8Array }[]>`
      SELECT snapshot FROM board_yjs_documents
      WHERE name = ${getPageYjsDocumentName(pageId)}
    `;
    return rows[0]?.snapshot ? new Uint8Array(rows[0].snapshot) : null;
  }

  private async findBinding(column: "r.task_page_id" | "r.id", id: string) {
    const sql = await this.sqlResolver.resolveSql();
    const rows = column === "r.task_page_id"
      ? await bindingRows(sql, "page", id)
      : await bindingRows(sql, "runbook", id);
    return rows[0] ?? null;
  }
}


async function assertLegacyBinding(
  sql: BoardYjsQuerySql,
  binding: LegacyRunbookBinding,
  pageId: string,
): Promise<void> {
  const rows = await sql<readonly { version: string | number; task_page_id: string | null }[]>`
    SELECT version, task_page_id FROM runbooks
    WHERE id = ${binding.runbookId}
    FOR UPDATE
  `;
  const row = rows[0];
  if (!row) throw new Error(`legacy runbook not found: ${binding.runbookId}`);
  if (Number(row.version) !== binding.runbookVersion) {
    throw new Error(`runbook version conflict: ${binding.runbookId}`);
  }
  if (row.task_page_id && row.task_page_id !== pageId) {
    throw new Error(`legacy runbook is already bound to page ${row.task_page_id}`);
  }
  const pages = await sql<readonly { exists: boolean }[]>`
    SELECT EXISTS(SELECT 1 FROM pages WHERE id = ${pageId}) AS exists
  `;
  if (!pages[0]?.exists) throw new Error(`legacy binding page not found: ${pageId}`);
}

async function persistLegacyBinding(
  sql: BoardYjsQuerySql,
  input: {
    binding: LegacyRunbookBinding;
    pageId: string;
    actor: Parameters<RunbookTaskIdentityRepository["create"]>[0]["actor"];
    idempotencyKey: string;
    operationId: string;
    eventId: number | null;
    createdPage: boolean;
    pageOperationId?: string;
  },
): Promise<Record<string, unknown>> {
  const rows = await sql<readonly Record<string, unknown>[]>`
    UPDATE runbooks
    SET task_page_id = ${input.pageId}, version = version + 1, updated_at = NOW()
    WHERE id = ${input.binding.runbookId}
      AND version = ${input.binding.runbookVersion}
    RETURNING *
  `;
  if (!rows[0]) throw new Error(`runbook version conflict: ${input.binding.runbookId}`);
  return await insertRunbookOperation(sql, {
    id: input.operationId,
    runbookId: input.binding.runbookId,
    operationType: "backfill_task_identity",
    actor: input.actor,
    eventId: input.eventId,
    idempotencyKey: input.idempotencyKey,
    payload: {
      page_id: input.pageId,
      created_page: input.createdPage,
      ...(input.pageOperationId ? { page_operation_id: input.pageOperationId } : {}),
    },
    reason: "backfill legacy runbook task identity",
  });
}
