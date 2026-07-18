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
  LegacyTaskBackfillResult,
  LegacyTaskBinding,
  TaskIdentityMutationResult,
  TaskIdentityRepository,
  TaskIdentityBinding,
} from "./task_identity_service.js";
import {
  bindingRows,
  legacyBindingRows,
  pageTitleRows,
} from "./task_identity_queries.js";
import {
  appendTaskEvent,
  findOperation,
  insertTaskOperation,
  legacyBackfillResult,
  operationTaskId,
  readResult,
  storeBoardApplication,
} from "./task_identity_operation_store.js";
import { commitTaskProjectMount } from "./task_project_mount_store.js";
import {
  assertTaskMountExpectation,
  commitTaskMountApplications,
  listTaskMountBindings,
  persistTaskProjectMove,
} from "./task_identity_lifecycle_store.js";
import {
  assertLegacyBinding,
  persistLegacyBinding,
} from "./task_identity_legacy_store.js";
import { persistTaskPromotion } from "./task_identity_promotion_store.js";

export class SqlTaskIdentityRepository implements TaskIdentityRepository {
  private readonly sqlResolver: BoardYjsSqlResolver;

  constructor(resolver: LiveDbSqlResolver) {
    this.sqlResolver = new BoardYjsSqlResolver(resolver);
  }

  async findMutationByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<TaskIdentityMutationResult | null> {
    const sql = await this.sqlResolver.resolveSql();
    const operation = await findOperation(sql, idempotencyKey);
    if (!operation) return null;
    const taskId = operationTaskId(operation);
    return await readResult(sql, taskId, operation, true);
  }

  async findLegacyBackfillByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<LegacyTaskBackfillResult | null> {
    const sql = await this.sqlResolver.resolveSql();
    const operation = await findOperation(sql, idempotencyKey);
    if (!operation) return null;
    if (operation.operation_type !== "backfill_task_identity") {
      throw new Error(`idempotency key belongs to ${String(operation.operation_type)}`);
    }
    return legacyBackfillResult(operation, true);
  }

  async create(
    input: Parameters<TaskIdentityRepository["create"]>[0],
  ): Promise<TaskIdentityMutationResult> {
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

      const collisions = await transaction<readonly { task_exists: boolean; page_exists: boolean }[]>`
        SELECT
          EXISTS(SELECT 1 FROM tasks WHERE id = ${input.taskId}) AS task_exists,
          EXISTS(SELECT 1 FROM pages WHERE id = ${input.pageId}) AS page_exists
      `;
      if (collisions[0]?.task_exists || collisions[0]?.page_exists) {
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
      const eventId = await appendTaskEvent(transaction, {
        actor: input.actor,
        operationId: input.operationId,
        operationType: "create_task",
        taskId: input.taskId,
        idempotencyKey: input.idempotencyKey,
      });
      const taskRows = await transaction<readonly Record<string, unknown>[]>`
        INSERT INTO tasks (
          id, board_item_id, task_page_id, title, created_session_id, created_event_id
        ) VALUES (
          ${input.taskId}, ${input.boardItemId}, ${input.taskPageId}, ${input.title},
          ${input.actor.actorSessionId ?? null}, ${eventId}
        )
        RETURNING *
      `;
      if (!taskRows[0]) throw new Error("task identity task insert returned no row");
      const operationRows = await transaction<readonly Record<string, unknown>[]>`
        INSERT INTO task_operations (
          id, task_id, target_kind, target_id, operation_type,
          actor_kind, actor_session_id, actor_event_id, actor_user_id,
          idempotency_key, payload_json, reason
        ) VALUES (
          ${input.operationId}, ${input.taskId}, ${"task"}, ${input.taskId},
          ${"create_task"}, ${input.actor.actorKind},
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
          ${"create task identity"}
        )
        RETURNING *
      `;
      const operation = operationRows[0];
      if (!operation) throw new Error("task identity operation insert returned no row");
      return await readResult(transaction, input.id, operation, false, pageCommit);
    });
  }

  async promote(
    input: Parameters<TaskIdentityRepository["promote"]>[0],
  ): Promise<TaskIdentityMutationResult> {
    return await persistTaskPromotion(
      await this.sqlResolver.resolveSql(),
      input,
    );
  }

  async mutate(
    input: Parameters<TaskIdentityRepository["mutate"]>[0],
  ): Promise<TaskIdentityMutationResult> {
    const sql = await this.sqlResolver.resolveSql();
    return await sql.begin(async (transaction) => {
      const lockIds = new Set([
        input.binding.taskId,
        ...(input.mountPageApplications ?? []).map((item) => item.pageId),
      ]);
      for (const lockId of [...lockIds].sort()) {
        await transaction`SELECT pg_advisory_xact_lock(hashtextextended(${lockId}, 0))`;
      }
      const existing = await findOperation(transaction, input.idempotencyKey);
      if (existing) {
        return await readResult(transaction, input.binding.taskId, existing, true);
      }
      const bindings = await bindingRows(transaction, "task", input.binding.taskId, true);
      const locked = bindings[0];
      if (!locked || locked.pageId !== input.binding.pageId) {
        throw new Error(`task identity mapping changed: ${input.binding.taskId}`);
      }
      if (locked.taskVersion !== input.expectedTaskVersion) {
        throw new Error(
          `task version conflict: ${input.binding.taskId} expected ${input.expectedTaskVersion}, actual ${locked.taskVersion}`,
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
      const eventId = await appendTaskEvent(transaction, {
        actor: input.actor,
        operationId: input.operationId,
        operationType: input.operationType,
        taskId: input.binding.taskId,
        idempotencyKey: input.idempotencyKey,
      });
      const updated = await transaction<readonly Record<string, unknown>[]>`
        UPDATE tasks
        SET title = ${input.title}, archived = ${input.archived},
            version = version + 1, updated_at = NOW()
        WHERE id = ${input.binding.taskId}
          AND version = ${input.expectedTaskVersion}
        RETURNING *
      `;
      if (!updated[0]) {
        throw new Error(`task version conflict: ${input.binding.taskId}`);
      }
      const operation = await insertTaskOperation(transaction, {
        id: input.operationId,
        taskId: input.binding.taskId,
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
        reason: input.pageApplication.reason ?? "mutate task identity",
      });
      return await readResult(
        transaction,
        input.binding.taskId,
        operation,
        false,
        pageCommit,
      );
    });
  }

  async move(
    input: Parameters<TaskIdentityRepository["move"]>[0],
  ): Promise<void> {
    await persistTaskProjectMove(await this.sqlResolver.resolveSql(), input);
  }

  async findLegacyTask(taskId: string): Promise<LegacyTaskBinding | null> {
    const sql = await this.sqlResolver.resolveSql();
    const rows = await legacyBindingRows(sql, taskId);
    return rows[0] ?? null;
  }

  async bindLegacyPage(
    input: Parameters<TaskIdentityRepository["bindLegacyPage"]>[0],
  ): Promise<LegacyTaskBackfillResult> {
    const sql = await this.sqlResolver.resolveSql();
    return await sql.begin(async (transaction) => {
      await transaction`SELECT pg_advisory_xact_lock(hashtextextended(${input.binding.taskId}, 0))`;
      const existing = await findOperation(transaction, input.idempotencyKey);
      if (existing) {
        return legacyBackfillResult(existing, true);
      }
      await assertLegacyBinding(transaction, input.binding, input.pageId);
      const eventId = await appendTaskEvent(transaction, {
        actor: input.actor,
        operationId: input.operationId,
        operationType: "update_task",
        taskId: input.binding.taskId,
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
    input: Parameters<TaskIdentityRepository["createLegacyPageAndBind"]>[0],
  ): Promise<LegacyTaskBackfillResult> {
    const sql = await this.sqlResolver.resolveSql();
    return await sql.begin(async (transaction) => {
      await transaction`SELECT pg_advisory_xact_lock(hashtextextended(${input.binding.taskId}, 0))`;
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
      const eventId = await appendTaskEvent(transaction, {
        actor: input.actor,
        operationId: input.operationId,
        operationType: "update_task",
        taskId: input.binding.taskId,
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

  async findByTaskId(taskId: string): Promise<TaskIdentityBinding | null> {
    return await this.findBinding("r.id", taskId);
  }

  async findPageByTitle(title: string) {
    const rows = await pageTitleRows(await this.sqlResolver.resolveSql(), title);
    return rows[0] ?? null;
  }

  async findCreateResultByTaskId(
    taskId: string,
  ): Promise<TaskIdentityMutationResult | null> {
    const sql = await this.sqlResolver.resolveSql();
    const operations = await sql<readonly Record<string, unknown>[]>`
      SELECT * FROM task_operations
      WHERE task_id = ${taskId}
        AND operation_type = 'create_task'
      ORDER BY created_at ASC, id ASC
      LIMIT 1
    `;
    if (!operations[0]) return null;
    const result = await readResult(sql, taskId, operations[0], true);
    const folders = await sql<readonly { project_page_id: string | null }[]>`
      SELECT folder.project_page_id
      FROM tasks task
      JOIN board_items board_item ON board_item.id = task.board_item_id
      JOIN folders folder ON folder.id = board_item.folder_id
      WHERE task.id = ${taskId}
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
      : await bindingRows(sql, "task", id);
    return rows[0] ?? null;
  }
}
