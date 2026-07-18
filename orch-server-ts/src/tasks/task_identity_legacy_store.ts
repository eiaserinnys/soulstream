import type { BoardYjsQuerySql } from "../board-yjs/board_yjs_sql.js";
import type {
  LegacyTaskBinding,
  TaskIdentityRepository,
} from "./task_identity_contracts.js";
import { insertTaskOperation } from "./task_identity_operation_store.js";

export async function assertLegacyBinding(
  sql: BoardYjsQuerySql,
  binding: LegacyTaskBinding,
  pageId: string,
): Promise<void> {
  const rows = await sql<readonly { version: string | number; task_page_id: string | null }[]>`
    SELECT version, task_page_id FROM tasks
    WHERE id = ${binding.taskId}
    FOR UPDATE
  `;
  const row = rows[0];
  if (!row) throw new Error(`legacy task not found: ${binding.taskId}`);
  if (Number(row.version) !== binding.taskVersion) {
    throw new Error(`task version conflict: ${binding.taskId}`);
  }
  if (row.task_page_id && row.task_page_id !== pageId) {
    throw new Error(`legacy task is already bound to page ${row.task_page_id}`);
  }
  const pages = await sql<readonly { exists: boolean }[]>`
    SELECT EXISTS(SELECT 1 FROM pages WHERE id = ${pageId}) AS exists
  `;
  if (!pages[0]?.exists) throw new Error(`legacy binding page not found: ${pageId}`);
}

export async function persistLegacyBinding(
  sql: BoardYjsQuerySql,
  input: {
    binding: LegacyTaskBinding;
    pageId: string;
    actor: Parameters<TaskIdentityRepository["create"]>[0]["actor"];
    idempotencyKey: string;
    operationId: string;
    eventId: number | null;
    createdPage: boolean;
    pageOperationId?: string;
  },
): Promise<Record<string, unknown>> {
  const rows = await sql<readonly Record<string, unknown>[]>`
    UPDATE tasks
    SET task_page_id = ${input.pageId}, version = version + 1, updated_at = NOW()
    WHERE id = ${input.binding.taskId}
      AND version = ${input.binding.taskVersion}
    RETURNING *
  `;
  if (!rows[0]) throw new Error(`task version conflict: ${input.binding.taskId}`);
  return await insertTaskOperation(sql, {
    id: input.operationId,
    taskId: input.binding.taskId,
    operationType: "backfill_task_identity",
    actor: input.actor,
    eventId: input.eventId,
    idempotencyKey: input.idempotencyKey,
    payload: {
      page_id: input.pageId,
      created_page: input.createdPage,
      ...(input.pageOperationId ? { page_operation_id: input.pageOperationId } : {}),
    },
    reason: "backfill legacy task identity",
  });
}
