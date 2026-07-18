import { Buffer } from "node:buffer";

import { syncBoardYjsReplicaWithSql } from "../board-yjs/board_yjs_repository.js";
import type { BoardYjsQuerySql } from "../board-yjs/board_yjs_sql.js";
import type {
  PageMutationCommitResult,
  PageOperationRecord,
} from "../page/page_repository.js";
import type {
  LegacyTaskBackfillResult,
  TaskIdentityMutationResult,
  TaskIdentityRepository,
} from "./task_identity_contracts.js";

export function legacyBackfillResult(
  operation: Record<string, unknown>,
  idempotent: boolean,
): LegacyTaskBackfillResult {
  const payload = asRecord(operation.payload_json);
  const taskId = operationTaskId(operation);
  const pageId = typeof payload.page_id === "string" ? payload.page_id : "";
  if (!pageId) throw new Error(`legacy backfill page id missing: ${taskId}`);
  const createdPage = payload.created_page === true;
  return { taskId, pageId, createdPage, operation, idempotent };
}

export function operationTaskId(operation: Record<string, unknown>): string {
  const taskId = typeof operation.task_id === "string" ? operation.task_id : "";
  if (!taskId) throw new Error("task operation is missing task_id");
  return taskId;
}

export async function appendTaskEvent(
  sql: BoardYjsQuerySql,
  input: {
    actor: Parameters<TaskIdentityRepository["create"]>[0]["actor"];
    operationId: string;
    operationType: "create_task" | "update_task" | "archive_task" | "unarchive_task";
    taskId: string;
    idempotencyKey: string;
  },
): Promise<number | null> {
  if (input.actor.actorKind !== "agent") return null;
  const rows = await sql<readonly { event_append: number }[]>`
    SELECT event_append(
      ${input.actor.actorSessionId},
      ${"task_operation"},
      ${JSON.stringify({
        operation_id: input.operationId,
        operation_type: input.operationType,
        task_id: input.taskId,
        target_kind: "task",
        target_id: input.taskId,
      })},
      ${`task operation ${input.operationType}`},
      ${new Date()},
      ${`${input.idempotencyKey}:task`}
    ) AS event_append
  `;
  const eventId = rows[0]?.event_append;
  if (typeof eventId !== "number") throw new Error("event_append returned no event id");
  return eventId;
}

export async function findOperation(
  sql: BoardYjsQuerySql,
  idempotencyKey: string,
): Promise<Record<string, unknown> | null> {
  const rows = await sql<readonly Record<string, unknown>[]>`
    SELECT * FROM task_operations
    WHERE idempotency_key = ${idempotencyKey}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function readResult(
  sql: BoardYjsQuerySql,
  taskId: string,
  operation: Record<string, unknown>,
  idempotent: boolean,
  pageCommit?: PageMutationCommitResult,
): Promise<TaskIdentityMutationResult> {
  const taskRows = await sql<readonly Record<string, unknown>[]>`
    SELECT * FROM tasks WHERE id = ${taskId}
  `;
  const task = taskRows[0];
  if (!task) throw new Error(`task identity task not found: ${taskId}`);
  const pageId = String(task.task_page_id ?? "");
  if (!pageId) throw new Error(`task identity page mapping missing: ${taskId}`);
  const payload = asRecord(operation.payload_json);
  const projectPageId = typeof payload.project_page_id === "string"
    ? payload.project_page_id
    : undefined;
  const resolvedPageCommit = pageCommit ?? await readPageCommit(sql, pageId, operation);
  const sections = await sql<readonly Record<string, unknown>[]>`
    SELECT * FROM task_sections WHERE task_id = ${taskId}
    ORDER BY position_key ASC, created_at ASC
  `;
  const items = await sql<readonly Record<string, unknown>[]>`
    SELECT i.* FROM task_items i
    JOIN task_sections s ON s.id = i.section_id
    WHERE s.task_id = ${taskId}
    ORDER BY s.position_key ASC, i.position_key ASC, i.created_at ASC
  `;
  return {
    id: taskId,
    pageId,
    taskId,
    ...(projectPageId ? { projectPageId } : {}),
    snapshot: { task, sections, items },
    operation,
    pageOperation: resolvedPageCommit.operation,
    pageCommit: resolvedPageCommit,
    idempotent,
  };
}

export async function storeBoardApplication(
  sql: BoardYjsQuerySql,
  application: Parameters<TaskIdentityRepository["create"]>[0]["boardApplication"],
): Promise<void> {
  await sql`
    INSERT INTO board_yjs_documents (name, snapshot, updated_at)
    VALUES (${application.documentName}, ${Buffer.from(application.snapshot)}, NOW())
    ON CONFLICT (name) DO UPDATE
    SET snapshot = EXCLUDED.snapshot, updated_at = EXCLUDED.updated_at
  `;
  await syncBoardYjsReplicaWithSql(
    sql,
    application.scope,
    application.replica,
    application.documentName,
  );
}

export async function insertTaskOperation(
  sql: BoardYjsQuerySql,
  input: {
    id: string;
    taskId: string;
    operationType: string;
    actor: Parameters<TaskIdentityRepository["create"]>[0]["actor"];
    eventId: number | null;
    idempotencyKey: string;
    payload: Record<string, unknown>;
    reason: string;
  },
): Promise<Record<string, unknown>> {
  const rows = await sql<readonly Record<string, unknown>[]>`
    INSERT INTO task_operations (
      id, task_id, target_kind, target_id, operation_type,
      actor_kind, actor_session_id, actor_event_id, actor_user_id,
      idempotency_key, payload_json, reason
    ) VALUES (
      ${input.id}, ${input.taskId}, ${"task"}, ${input.taskId},
      ${input.operationType}, ${input.actor.actorKind},
      ${input.actor.actorSessionId ?? null}, ${input.eventId},
      ${input.actor.actorUserId ?? null}, ${input.idempotencyKey},
      ${sql.json(input.payload)}::jsonb, ${input.reason}
    )
    RETURNING *
  `;
  if (!rows[0]) throw new Error("task identity operation insert returned no row");
  return rows[0];
}

async function readPageCommit(
  sql: BoardYjsQuerySql,
  pageId: string,
  taskOperation: Record<string, unknown>,
): Promise<PageMutationCommitResult> {
  const payload = asRecord(taskOperation.payload_json);
  const pageOperationId = typeof payload.page_operation_id === "string"
    ? payload.page_operation_id
    : null;
  const operationRows = pageOperationId
    ? await sql<readonly PageOperationRecord[]>`
        SELECT * FROM block_operations WHERE id = ${pageOperationId} AND page_id = ${pageId}
      `
    : await sql<readonly PageOperationRecord[]>`
        SELECT * FROM block_operations
        WHERE page_id = ${pageId}
        ORDER BY created_at DESC
        LIMIT 1
      `;
  const operation = operationRows[0];
  if (!operation) throw new Error(`task identity page operation missing: ${pageId}`);
  const pageRows = await sql<readonly { created_at: Date; updated_at: Date }[]>`
    SELECT created_at, updated_at FROM pages WHERE id = ${pageId}
  `;
  const page = pageRows[0];
  if (!page) throw new Error(`task identity page not found: ${pageId}`);
  return {
    operation,
    pageCreatedAt: page.created_at,
    pageUpdatedAt: page.updated_at,
    idempotent: true,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
