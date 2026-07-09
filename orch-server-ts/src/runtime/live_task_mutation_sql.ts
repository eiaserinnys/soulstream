import { TaskMutationRouteError } from "../tasks/task_mutation_routes.js";
import type { SerializedTaskOperation } from "../tasks/task_mutation_routes.js";
import type {
  ArchiveTaskPayload,
  HoldTaskPayload,
  LinkTaskPayload,
  MoveTaskPayload,
  PinTaskPayload,
  TaskOperationsQuery,
  TaskStatusPayload,
  UpdateTaskPayload,
} from "../tasks/task_mutation_payloads.js";
import type { LivePostgresSql } from "./live_db_sql.js";
import { serializeTaskOperation } from "./live_task_serialization.js";

export async function nextPositionKey(
  sql: LivePostgresSql,
  parentTaskId: string | undefined,
): Promise<number> {
  const rows = await sql`
    SELECT COALESCE(MAX(position_key), 0) + 1 AS position_key
    FROM task_items
    WHERE ((${parentTaskId ?? null}::text IS NULL AND parent_id IS NULL) OR parent_id = ${parentTaskId ?? null})
  `;
  return numberValue(rows[0]?.position_key) ?? 1;
}

export async function wouldCreateCycle(
  sql: LivePostgresSql,
  taskId: string,
  candidateParentId: string | null,
): Promise<boolean> {
  if (candidateParentId === null) return false;
  if (taskId === candidateParentId) return true;
  const rows = await sql`
    WITH RECURSIVE descendants AS (
      SELECT id FROM task_items WHERE parent_id = ${taskId}
      UNION ALL
      SELECT child.id
      FROM task_items child
      JOIN descendants d ON child.parent_id = d.id
    )
    SELECT EXISTS (SELECT 1 FROM descendants WHERE id = ${candidateParentId}) AS would_create_cycle
  `;
  return rows[0]?.would_create_cycle === true;
}

export async function patchTaskStatus(
  sql: LivePostgresSql,
  taskId: string,
  payload: TaskStatusPayload,
): Promise<Record<string, unknown>> {
  const rows = await sql`
    UPDATE task_items
    SET status = ${payload.status},
        updated_at = NOW(),
        version = version + 1
    WHERE id = ${taskId}
      AND (${payload.expectedVersion ?? null}::integer IS NULL OR version = ${payload.expectedVersion ?? null})
    RETURNING *
  `;
  return requirePatchedTask(rows);
}

export async function patchTaskFields(
  sql: LivePostgresSql,
  taskId: string,
  payload: UpdateTaskPayload,
): Promise<Record<string, unknown>> {
  const rows = await sql`
    UPDATE task_items
    SET title = CASE WHEN ${payload.title !== undefined}::boolean THEN ${payload.title ?? null}::text ELSE title END,
        description = CASE WHEN ${payload.description !== undefined}::boolean THEN ${payload.description ?? null}::text ELSE description END,
        acceptance_criteria = CASE WHEN ${payload.acceptanceCriteria !== undefined}::boolean THEN ${payload.acceptanceCriteria ?? null}::text ELSE acceptance_criteria END,
        updated_at = NOW(),
        version = version + 1
    WHERE id = ${taskId}
      AND (${payload.expectedVersion ?? null}::integer IS NULL OR version = ${payload.expectedVersion ?? null})
    RETURNING *
  `;
  return requirePatchedTask(rows);
}

export async function patchTaskMove(
  sql: LivePostgresSql,
  taskId: string,
  payload: MoveTaskPayload,
  positionKey: number,
): Promise<Record<string, unknown>> {
  const rows = await sql`
    UPDATE task_items
    SET parent_id = ${payload.newParentTaskId ?? null},
        position_key = ${positionKey},
        updated_at = NOW(),
        version = version + 1
    WHERE id = ${taskId}
      AND (${payload.expectedVersion ?? null}::integer IS NULL OR version = ${payload.expectedVersion ?? null})
    RETURNING *
  `;
  return requirePatchedTask(rows);
}

export async function patchTaskLink(
  sql: LivePostgresSql,
  taskId: string,
  payload: LinkTaskPayload,
): Promise<Record<string, unknown>> {
  const rows = await sql`
    UPDATE task_items
    SET linked_session_id = ${payload.linkedSessionId},
        linked_node_id = ${payload.linkedNodeId ?? null},
        navigation_session_id = ${payload.linkedSessionId},
        navigation_node_id = ${payload.linkedNodeId ?? null},
        navigation_event_id = ${payload.useOperationAnchor ? null : payload.navigationEventId ?? null},
        updated_at = NOW(),
        version = version + 1
    WHERE id = ${taskId}
      AND (${payload.expectedVersion ?? null}::integer IS NULL OR version = ${payload.expectedVersion ?? null})
    RETURNING *
  `;
  return requirePatchedTask(rows);
}

export async function patchTaskLinkAnchor(
  sql: LivePostgresSql,
  taskId: string,
  sessionId: string,
  eventId: number,
): Promise<Record<string, unknown>> {
  const rows = await sql`
    UPDATE task_items
    SET navigation_session_id = ${sessionId},
        navigation_event_id = ${eventId},
        updated_at = NOW(),
        version = version + 1
    WHERE id = ${taskId}
    RETURNING *
  `;
  return requirePatchedTask(rows);
}

export async function patchTaskHold(
  sql: LivePostgresSql,
  taskId: string,
  payload: HoldTaskPayload,
): Promise<Record<string, unknown>> {
  return patchTaskStatus(sql, taskId, {
    sessionId: payload.sessionId,
    status: "blocked",
    reason: payload.reason,
    expectedVersion: payload.expectedVersion,
    idempotencyKey: payload.idempotencyKey,
  });
}

export async function patchTaskArchive(
  sql: LivePostgresSql,
  taskId: string,
  payload: ArchiveTaskPayload,
): Promise<Record<string, unknown>> {
  const rows = await sql`
    UPDATE task_items
    SET archived = TRUE,
        active_for_session_id = NULL,
        updated_at = NOW(),
        version = version + 1
    WHERE id = ${taskId}
      AND (${payload.expectedVersion ?? null}::integer IS NULL OR version = ${payload.expectedVersion ?? null})
    RETURNING *
  `;
  return requirePatchedTask(rows);
}

export async function patchTaskPinned(
  sql: LivePostgresSql,
  taskId: string,
  payload: PinTaskPayload,
): Promise<Record<string, unknown>> {
  const rows = await sql`
    UPDATE task_items
    SET pinned = ${payload.pinned},
        updated_at = NOW(),
        version = version + 1
    WHERE id = ${taskId}
      AND (${payload.expectedVersion ?? null}::integer IS NULL OR version = ${payload.expectedVersion ?? null})
    RETURNING *
  `;
  return requirePatchedTask(rows);
}

export async function patchTaskCreateAnchors(
  sql: LivePostgresSql,
  taskId: string,
  createdFromEventId: number,
  navigationEventId: number | null,
): Promise<Record<string, unknown>> {
  const rows = await sql`
    UPDATE task_items
    SET created_from_event_id = ${createdFromEventId},
        navigation_event_id = ${navigationEventId},
        updated_at = NOW(),
        version = version + 1
    WHERE id = ${taskId}
    RETURNING *
  `;
  return requirePatchedTask(rows);
}

export async function listTaskOperations(
  sql: LivePostgresSql,
  taskId: string,
  query: TaskOperationsQuery,
): Promise<SerializedTaskOperation[]> {
  const rows = await sql`
    SELECT * FROM task_operations
    WHERE task_id = ${taskId}
    ORDER BY created_at DESC
    LIMIT ${query.limit}
  `;
  return rows.map(serializeTaskOperation);
}

export function taskUpdatePayload(payload: UpdateTaskPayload): Record<string, unknown> {
  const update: Record<string, unknown> = {};
  if (payload.title !== undefined) update.title = payload.title;
  if (payload.description !== undefined) update.description = payload.description;
  if (payload.acceptanceCriteria !== undefined) {
    update.acceptance_criteria = payload.acceptanceCriteria;
  }
  return update;
}

function requirePatchedTask(
  rows: readonly Record<string, unknown>[],
): Record<string, unknown> {
  const row = rows[0];
  if (row === undefined) {
    throw new TaskMutationRouteError(409, "task item not found or version mismatch");
  }
  return row;
}

function numberValue(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
