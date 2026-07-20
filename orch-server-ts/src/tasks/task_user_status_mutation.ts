import { randomUUID } from "node:crypto";

import { BoardYjsSqlResolver, type BoardYjsQuerySql } from "../board-yjs/board_yjs_sql.js";
import type { LiveDbSqlResolver } from "../runtime/live_db_sql.js";
import {
  TaskRouteError,
  type TaskSnapshot,
  type TaskUserStatusMutation,
  type TaskUserStatusMutationInput,
} from "./task_route_types.js";

export type CreateTaskUserStatusMutationOptions = {
  sqlResolver: LiveDbSqlResolver;
  loadSnapshot: (taskId: string) => Promise<TaskSnapshot | null | undefined>;
  createOperationId?: () => string;
};

/**
 * Dashboard users do not necessarily have a session. This is the canonical
 * sessionless task-status boundary: attribution is user-only and no fake
 * session event is manufactured.
 */
export function createTaskUserStatusMutation(
  options: CreateTaskUserStatusMutationOptions,
): TaskUserStatusMutation {
  const sqlResolver = new BoardYjsSqlResolver(options.sqlResolver);
  const createOperationId = options.createOperationId ?? randomUUID;

  return async (input) => {
    const sql = await sqlResolver.resolveSql();
    const committed = await sql.begin(async (transaction) => {
      await transaction`
        SELECT pg_advisory_xact_lock(hashtextextended(${input.taskId}, 0))
      `;
      const existingRows = await transaction<readonly Record<string, unknown>[]>`
        SELECT * FROM task_operations
        WHERE idempotency_key = ${input.idempotencyKey}
        LIMIT 1
      `;
      const existing = existingRows[0];
      if (existing !== undefined) {
        assertMatchingIdempotentOperation(existing, input);
        return {
          operation: existing,
          boardItemId: "",
          idempotent: true,
        };
      }

      const taskRows = await transaction<readonly Record<string, unknown>[]>`
        SELECT id, board_item_id, version
        FROM tasks
        WHERE id = ${input.taskId}
        FOR UPDATE
      `;
      const task = taskRows[0];
      if (task === undefined) {
        throw new TaskRouteError("TASK_NOT_FOUND", "Task not found", 404);
      }
      const actualVersion = numberValue(task.version);
      if (actualVersion !== input.expectedVersion) {
        throw versionConflict(input, actualVersion);
      }

      const updated = input.status === "completed"
        ? await completeTask(transaction, input)
        : await reopenTask(transaction, input);
      if (updated[0] === undefined) {
        throw versionConflict(input, actualVersion);
      }

      const operationId = createOperationId();
      const operationRows = await transaction<readonly Record<string, unknown>[]>`
        INSERT INTO task_operations (
          id, task_id, target_kind, target_id, operation_type,
          actor_kind, actor_session_id, actor_event_id, actor_user_id,
          idempotency_key, payload_json, reason
        ) VALUES (
          ${operationId}, ${input.taskId}, ${"task"}, ${input.taskId},
          ${"set_task_status"}, ${"user"}, ${null}, ${null}, ${input.userId},
          ${input.idempotencyKey}, ${transaction.json({ status: input.status })}::jsonb,
          ${input.reason ?? null}
        )
        RETURNING *
      `;
      const operation = operationRows[0];
      if (operation === undefined) {
        throw new TaskRouteError(
          "TASK_STATUS_OPERATION_MISSING",
          "Task status operation insert returned no row",
          500,
        );
      }
      return {
        operation,
        boardItemId: requiredString(task.board_item_id, "task.board_item_id"),
        idempotent: false,
      };
    });

    const snapshot = await options.loadSnapshot(input.taskId);
    if (snapshot === undefined || snapshot === null) {
      throw new TaskRouteError("TASK_NOT_FOUND", "Task not found", 404);
    }
    const snapshotBoardItemId = stringValue(snapshot.task?.board_item_id);
    const boardItemId = committed.boardItemId || snapshotBoardItemId;
    if (!boardItemId) {
      throw new TaskRouteError(
        "TASK_BOARD_ITEM_ID_MISSING",
        "Task board item id is missing",
        500,
      );
    }
    return {
      ok: true,
      taskId: input.taskId,
      boardItemId,
      eventId: 0,
      idempotent: committed.idempotent,
      operation: committed.operation,
      snapshot,
    };
  };
}

function completeTask(
  sql: BoardYjsQuerySql,
  input: TaskUserStatusMutationInput,
): Promise<readonly Record<string, unknown>[]> {
  return sql<readonly Record<string, unknown>[]>`
    UPDATE tasks
    SET status = ${input.status},
        completed_kind = ${"user"},
        completed_session_id = NULL,
        completed_event_id = NULL,
        completed_user_id = ${input.userId},
        completed_at = NOW(),
        updated_at = NOW(),
        version = version + 1
    WHERE id = ${input.taskId}
      AND version = ${input.expectedVersion}
    RETURNING *
  `;
}

function reopenTask(
  sql: BoardYjsQuerySql,
  input: TaskUserStatusMutationInput,
): Promise<readonly Record<string, unknown>[]> {
  return sql<readonly Record<string, unknown>[]>`
    UPDATE tasks
    SET status = ${input.status},
        completed_kind = NULL,
        completed_session_id = NULL,
        completed_event_id = NULL,
        completed_user_id = NULL,
        completed_at = NULL,
        updated_at = NOW(),
        version = version + 1
    WHERE id = ${input.taskId}
      AND version = ${input.expectedVersion}
    RETURNING *
  `;
}

function assertMatchingIdempotentOperation(
  operation: Record<string, unknown>,
  input: TaskUserStatusMutationInput,
): void {
  const payload = isRecord(operation.payload_json) ? operation.payload_json : {};
  if (
    operation.task_id !== input.taskId ||
    operation.target_kind !== "task" ||
    operation.target_id !== input.taskId ||
    operation.operation_type !== "set_task_status" ||
    operation.actor_kind !== "user" ||
    operation.actor_user_id !== input.userId ||
    payload.status !== input.status
  ) {
    throw new TaskRouteError(
      "TASK_IDEMPOTENCY_CONFLICT",
      "Idempotency key belongs to another task operation",
      409,
    );
  }
}

function versionConflict(
  input: TaskUserStatusMutationInput,
  actualVersion: number,
): TaskRouteError {
  return new TaskRouteError(
    "TASK_VERSION_CONFLICT",
    `task version conflict: ${input.taskId} expected ${input.expectedVersion}, actual ${actualVersion}`,
    409,
    {
      targetKind: "task",
      targetId: input.taskId,
      expectedVersion: input.expectedVersion,
      actualVersion,
    },
  );
}

function numberValue(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new TaskRouteError("TASK_VERSION_INVALID", "Task version is invalid", 500);
  }
  return parsed;
}

function requiredString(value: unknown, label: string): string {
  const normalized = stringValue(value);
  if (normalized) return normalized;
  throw new TaskRouteError("TASK_RECORD_INVALID", `${label} is missing`, 500);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
