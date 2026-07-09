import type { InMemoryNodeRegistry } from "../node/registry.js";
import type { SerializedTaskOperation } from "../tasks/task_mutation_routes.js";
import type { SerializedTaskItem } from "../tasks/task_read_routes.js";
import type { LivePostgresSql } from "./live_db_sql.js";
import {
  iso,
  serializeTaskRow,
} from "./live_session_serialization.js";

export type LiveTaskSerializationOptions = {
  readonly registry?: InMemoryNodeRegistry;
};

export async function serializeTasksWithLinkedSessions(
  sql: LivePostgresSql,
  taskRows: readonly Record<string, unknown>[],
  options: LiveTaskSerializationOptions = {},
): Promise<SerializedTaskItem[]> {
  const linkedSessions = await linkedSessionsById(sql, taskRows);
  return taskRows.map((row) =>
    serializeTaskRow(
      row,
      linkedSessions.get(String(row.linked_session_id)),
      options,
    ) as SerializedTaskItem,
  );
}

export async function serializeTaskWithLinkedSession(
  sql: LivePostgresSql,
  taskRow: Record<string, unknown> | null | undefined,
  options: LiveTaskSerializationOptions = {},
): Promise<SerializedTaskItem | null> {
  if (taskRow === null || taskRow === undefined) return null;
  const [task] = await serializeTasksWithLinkedSessions(sql, [taskRow], options);
  return task ?? null;
}

export function serializeTaskOperation(
  row: Record<string, unknown>,
): SerializedTaskOperation {
  return {
    id: String(row.id),
    taskId: stringOrNull(row.task_id),
    operationType: String(row.operation_type),
    actorKind: stringOrNull(row.actor_kind),
    actorSessionId: stringOrNull(row.actor_session_id),
    actorEventId: numberOrNull(row.actor_event_id),
    actorUserId: stringOrNull(row.actor_user_id),
    idempotencyKey: stringOrNull(row.idempotency_key),
    payload: jsonValue(row.payload_json) ?? {},
    reason: stringOrNull(row.reason),
    createdAt: iso(row.created_at),
  };
}

async function linkedSessionsById(
  sql: LivePostgresSql,
  taskRows: readonly Record<string, unknown>[],
): Promise<Map<string, Record<string, unknown>>> {
  const ids = [...new Set(taskRows.flatMap(linkedSessionId))].sort();
  if (ids.length === 0) return new Map();
  const rows = await sql`
    SELECT * FROM sessions WHERE session_id = ANY(${ids}::text[])
  `;
  return new Map(rows.map((row) => [String(row.session_id), row]));
}

function linkedSessionId(row: Record<string, unknown>): string[] {
  return typeof row.linked_session_id === "string" && row.linked_session_id
    ? [row.linked_session_id]
    : [];
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function jsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}
