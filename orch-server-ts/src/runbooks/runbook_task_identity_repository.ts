import { Buffer } from "node:buffer";

import {
  syncBoardYjsReplicaWithSql,
} from "../board-yjs/board_yjs_repository.js";
import {
  BoardYjsSqlResolver,
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
import {
  bindingRows,
  legacyBindingRows,
  pageTitleRows,
} from "./runbook_task_identity_queries.js";
import {
  appendRunbookEvent,
  findOperation,
  insertRunbookOperation,
  legacyBackfillResult,
  operationRunbookId,
  readResult,
  storeBoardApplication,
} from "./runbook_task_identity_operation_store.js";
import { commitTaskProjectMount } from "./runbook_task_project_mount_store.js";
import {
  assertTaskMountExpectation,
  commitTaskMountApplications,
  listTaskMountBindings,
  persistTaskProjectMove,
} from "./runbook_task_identity_lifecycle_store.js";
import {
  assertLegacyBinding,
  persistLegacyBinding,
} from "./runbook_task_identity_legacy_store.js";
import { persistRunbookTaskPromotion } from "./runbook_task_identity_promotion_store.js";

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
      for (const pageId of [input.id, input.expectedProjectPageId].filter(
        (value): value is string => value !== null,
      ).sort()) {
        await transaction`SELECT pg_advisory_xact_lock(hashtextextended(${pageId}, 0))`;
      }
      const existing = await findOperation(transaction, input.idempotencyKey);
      if (existing) return await readResult(transaction, input.id, existing, true);

      const folders = await transaction<readonly { project_page_id: string | null }[]>`
        SELECT project_page_id FROM folders WHERE id = ${input.folderId} FOR UPDATE
      `;
      if (!folders[0]) throw new Error(`task identity folder not found: ${input.folderId}`);
      if (folders[0].project_page_id !== input.expectedProjectPageId) {
        throw new Error(`task identity project mapping changed: ${input.folderId}`);
      }
      const expectsProjectMount = Boolean(input.expectedProjectPageId);
      if (
        Boolean(input.projectPageApplication) !== expectsProjectMount
        || Boolean(input.projectPageOperationId) !== expectsProjectMount
      ) {
        throw new Error("task identity project mount application is incomplete");
      }

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
      const projectPageCommit = input.projectPageApplication && input.projectPageOperationId
        ? await commitTaskProjectMount(transaction, {
          pageId: input.expectedProjectPageId!,
          operationId: input.projectPageOperationId,
          application: input.projectPageApplication,
        })
        : null;
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
            ...(input.expectedProjectPageId
              ? { project_page_id: input.expectedProjectPageId }
              : {}),
            ...(projectPageCommit
              ? { project_page_operation_id: projectPageCommit.operation.id }
              : {}),
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
    return await persistRunbookTaskPromotion(
      await this.sqlResolver.resolveSql(),
      input,
    );
  }

  async mutate(
    input: Parameters<RunbookTaskIdentityRepository["mutate"]>[0],
  ): Promise<RunbookTaskIdentityMutationResult> {
    const sql = await this.sqlResolver.resolveSql();
    return await sql.begin(async (transaction) => {
      const lockIds = new Set([
        input.binding.runbookId,
        ...(input.mountPageApplications ?? []).map((item) => item.pageId),
      ]);
      for (const lockId of [...lockIds].sort()) {
        await transaction`SELECT pg_advisory_xact_lock(hashtextextended(${lockId}, 0))`;
      }
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
      await assertTaskMountExpectation(
        transaction,
        input.binding.pageId,
        input.mountExpectation,
      );
      await storeBoardApplication(transaction, input.boardApplication);
      const pageCommitInput = {
        documentName: getPageYjsDocumentName(input.binding.pageId),
        application: input.pageApplication,
        operationId: input.pageOperationId,
      };
      await assertDatabaseMutationVersion(transaction, pageCommitInput);
      const pageCommit = await commitPageMutationInTransaction(transaction, pageCommitInput);
      const mountCommits = await commitTaskMountApplications(
        transaction,
        input.mountPageApplications ?? [],
      );
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
          ...(mountCommits.length > 0
            ? { mount_page_operation_ids: mountCommits.map((commit) => commit.operation.id) }
            : {}),
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

  async move(
    input: Parameters<RunbookTaskIdentityRepository["move"]>[0],
  ): Promise<void> {
    await persistTaskProjectMove(await this.sqlResolver.resolveSql(), input);
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

  async findPageByTitle(title: string) {
    const rows = await pageTitleRows(await this.sqlResolver.resolveSql(), title);
    return rows[0] ?? null;
  }

  async findCreateResultByRunbookId(
    runbookId: string,
  ): Promise<RunbookTaskIdentityMutationResult | null> {
    const sql = await this.sqlResolver.resolveSql();
    const operations = await sql<readonly Record<string, unknown>[]>`
      SELECT * FROM runbook_operations
      WHERE runbook_id = ${runbookId}
        AND operation_type = 'create_runbook'
      ORDER BY created_at ASC, id ASC
      LIMIT 1
    `;
    if (!operations[0]) return null;
    const result = await readResult(sql, runbookId, operations[0], true);
    const folders = await sql<readonly { project_page_id: string | null }[]>`
      SELECT folder.project_page_id
      FROM runbooks runbook
      JOIN board_items board_item ON board_item.id = runbook.board_item_id
      JOIN folders folder ON folder.id = board_item.folder_id
      WHERE runbook.id = ${runbookId}
      LIMIT 1
    `;
    if (folders[0]?.project_page_id) {
      return { ...result, projectPageId: folders[0].project_page_id };
    }
    const current = { ...result };
    delete current.projectPageId;
    return current;
  }

  async findProjectPageByFolderId(folderId: string) {
    const sql = await this.sqlResolver.resolveSql();
    const rows = await sql<readonly { page_id: string }[]>`
      SELECT page.id AS page_id
      FROM folders folder
      JOIN pages page ON page.id = folder.project_page_id
      WHERE folder.id = ${folderId}
        AND folder.archived = FALSE
        AND page.archived = FALSE
      LIMIT 1
    `;
    return rows[0] ? { pageId: rows[0].page_id } : null;
  }

  async listTaskMounts(pageId: string, scope: "all" | "project") {
    return await listTaskMountBindings(await this.sqlResolver.resolveSql(), pageId, scope);
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
