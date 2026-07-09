import { randomUUID } from "node:crypto";

import { TaskMutationRouteError } from "../tasks/task_mutation_routes.js";
import type {
  SerializedTaskOperation,
  TaskMutationResponse,
  TaskMutationRouteProvider,
} from "../tasks/task_mutation_routes.js";
import type { CreateTaskPayload } from "../tasks/task_mutation_payloads.js";
import type { LiveDbSqlResolver, LivePostgresSql } from "./live_db_sql.js";
import { serializeTaskRow } from "./live_session_serialization.js";
import {
  listTaskOperations,
  nextPositionKey,
  patchTaskArchive,
  patchTaskCreateAnchors,
  patchTaskFields,
  patchTaskHold,
  patchTaskLink,
  patchTaskLinkAnchor,
  patchTaskMove,
  patchTaskPinned,
  patchTaskStatus,
  taskUpdatePayload,
  wouldCreateCycle,
} from "./live_task_mutation_sql.js";
import {
  serializeTaskOperation,
  serializeTaskWithLinkedSession,
} from "./live_task_serialization.js";
import type { InMemoryNodeRegistry } from "../node/registry.js";

export type CreateLiveTaskMutationProviderOptions = {
  readonly sqlResolver: LiveDbSqlResolver;
  readonly registry?: InMemoryNodeRegistry;
};

type OperationInput = {
  readonly actorSessionId: string;
  readonly task: Record<string, unknown> | null;
  readonly operationType: string;
  readonly payload: Record<string, unknown>;
  readonly reason?: string;
  readonly idempotencyKey?: string;
};

type RecordedOperation = {
  readonly operation: SerializedTaskOperation;
  readonly eventId: number;
};

export function createLiveTaskMutationProvider(
  options: CreateLiveTaskMutationProviderOptions,
): TaskMutationRouteProvider {
  return {
    async createTask(payload) {
      const sql = await options.sqlResolver.resolveSql();
      const existing = await idempotentResult(sql, payload.idempotencyKey, options);
      if (existing !== null) return existing;
      return createTask(sql, payload, options);
    },
    async setTaskStatus(taskId, payload) {
      const sql = await options.sqlResolver.resolveSql();
      const existing = await idempotentResult(sql, payload.idempotencyKey, options);
      if (existing !== null) return existing;
      const task = await patchTaskStatus(sql, taskId, payload);
      return recordMutation(sql, task, {
        actorSessionId: payload.sessionId,
        task,
        operationType: "set_task_status",
        payload: { status: payload.status },
        reason: payload.reason,
        idempotencyKey: payload.idempotencyKey,
      }, options);
    },
    async updateTask(taskId, payload) {
      const sql = await options.sqlResolver.resolveSql();
      const existing = await idempotentResult(sql, payload.idempotencyKey, options);
      if (existing !== null) return existing;
      const task = await patchTaskFields(sql, taskId, payload);
      return recordMutation(sql, task, {
        actorSessionId: payload.sessionId,
        task,
        operationType: "update_task_item",
        payload: taskUpdatePayload(payload),
        reason: payload.reason,
        idempotencyKey: payload.idempotencyKey,
      }, options);
    },
    async moveTask(taskId, payload) {
      const sql = await options.sqlResolver.resolveSql();
      const existing = await idempotentResult(sql, payload.idempotencyKey, options);
      if (existing !== null) return existing;
      if (await wouldCreateCycle(sql, taskId, payload.newParentTaskId ?? null)) {
        throw new TaskMutationRouteError(422, "task tree cycle is not allowed");
      }
      const positionKey =
        payload.positionKey ?? await nextPositionKey(sql, payload.newParentTaskId);
      const task = await patchTaskMove(sql, taskId, payload, positionKey);
      return recordMutation(sql, task, {
        actorSessionId: payload.sessionId,
        task,
        operationType: "move_task_item",
        payload: {
          new_parent_task_id: payload.newParentTaskId,
          position_key: positionKey,
        },
        reason: payload.reason,
        idempotencyKey: payload.idempotencyKey,
      }, options);
    },
    async linkTask(taskId, payload) {
      const sql = await options.sqlResolver.resolveSql();
      let task = await patchTaskLink(sql, taskId, payload);
      const recorded = await recordOperation(sql, {
        actorSessionId: payload.sessionId,
        task,
        operationType: "link_task_session",
        payload: {
          linked_session_id: payload.linkedSessionId,
          linked_node_id: payload.linkedNodeId,
          navigation_event_id: payload.navigationEventId,
          use_operation_anchor: payload.useOperationAnchor,
        },
        reason: payload.reason,
      });
      if (payload.useOperationAnchor) {
        task = await patchTaskLinkAnchor(sql, taskId, payload.sessionId, recorded.eventId);
      }
      return mutationResponse(sql, task, recorded.operation, recorded.eventId, options);
    },
    async holdTask(taskId, payload) {
      const sql = await options.sqlResolver.resolveSql();
      const existing = await idempotentResult(sql, payload.idempotencyKey, options);
      if (existing !== null) return existing;
      const task = await patchTaskHold(sql, taskId, payload);
      return recordMutation(sql, task, {
        actorSessionId: payload.sessionId,
        task,
        operationType: "hold_task_item",
        payload: { status: "blocked" },
        reason: payload.reason,
        idempotencyKey: payload.idempotencyKey,
      }, options);
    },
    async archiveTask(taskId, payload) {
      const sql = await options.sqlResolver.resolveSql();
      const task = await patchTaskArchive(sql, taskId, payload);
      return recordMutation(sql, task, {
        actorSessionId: payload.sessionId,
        task,
        operationType: "archive_task_item",
        payload: { archived: true },
        reason: payload.reason,
      }, options);
    },
    async pinTask(taskId, payload) {
      const sql = await options.sqlResolver.resolveSql();
      const existing = await idempotentResult(sql, payload.idempotencyKey, options);
      if (existing !== null) return existing;
      const task = await patchTaskPinned(sql, taskId, payload);
      return recordMutation(sql, task, {
        actorSessionId: payload.sessionId,
        task,
        operationType: "set_task_pinned",
        payload: { pinned: payload.pinned },
        reason: payload.reason,
        idempotencyKey: payload.idempotencyKey,
      }, options);
    },
    async listTaskOperations(taskId, query) {
      const sql = await options.sqlResolver.resolveSql();
      return listTaskOperations(sql, taskId, query);
    },
  };
}

async function createTask(
  sql: LivePostgresSql,
  payload: CreateTaskPayload,
  options: CreateLiveTaskMutationProviderOptions,
): Promise<TaskMutationResponse> {
  const positionKey = await nextPositionKey(sql, payload.parentTaskId);
  const taskId = randomUUID();
  if (payload.setActive) {
    await sql`
      UPDATE task_items
      SET active_for_session_id = NULL,
          updated_at = NOW(),
          version = version + 1
      WHERE active_for_session_id = ${payload.sessionId}
    `;
  }
  const navigationSessionId =
    payload.navigationSessionId ?? payload.linkedSessionId ?? payload.sessionId;
  const navigationNodeId =
    payload.navigationNodeId ??
    (navigationSessionId === payload.linkedSessionId ? payload.linkedNodeId ?? null : null);
  const rows = await sql`
    INSERT INTO task_items (
      id, parent_id, position_key, title, description,
      acceptance_criteria, verification_owner, status,
      linked_session_id, linked_node_id,
      active_for_session_id, created_from_session_id,
      navigation_session_id, navigation_node_id, navigation_event_id
    )
    VALUES (
      ${taskId}, ${payload.parentTaskId ?? null}, ${positionKey}, ${payload.title},
      ${payload.description}, ${payload.acceptanceCriteria},
      ${payload.verificationOwner}, ${payload.status},
      ${payload.linkedSessionId ?? null}, ${payload.linkedNodeId ?? null},
      ${payload.setActive ? payload.sessionId : null}, ${payload.sessionId},
      ${navigationSessionId}, ${navigationNodeId}, ${payload.navigationEventId ?? null}
    )
    RETURNING *
  `;
  let task = requireTaskRow(rows);
  const recorded = await recordOperation(sql, {
    actorSessionId: payload.sessionId,
    task,
    operationType: "create_task_item",
    payload: {
      title: payload.title,
      parent_task_id: payload.parentTaskId,
      linked_session_id: payload.linkedSessionId,
      linked_node_id: payload.linkedNodeId,
      navigation_session_id: navigationSessionId,
      navigation_node_id: navigationNodeId,
      navigation_event_id: payload.navigationEventId,
    },
    idempotencyKey: payload.idempotencyKey,
  });
  const useOperationAnchor =
    payload.linkedSessionId === undefined &&
    payload.navigationSessionId === undefined &&
    payload.navigationEventId === undefined;
  task = await patchTaskCreateAnchors(
    sql,
    taskId,
    recorded.eventId,
    useOperationAnchor ? recorded.eventId : payload.navigationEventId ?? null,
  );
  return mutationResponse(sql, task, recorded.operation, recorded.eventId, options);
}

async function idempotentResult(
  sql: LivePostgresSql,
  idempotencyKey: string | undefined,
  options: CreateLiveTaskMutationProviderOptions,
): Promise<TaskMutationResponse | null> {
  if (idempotencyKey === undefined || idempotencyKey.length === 0) return null;
  const operationRows = await sql`
    SELECT * FROM task_operations WHERE idempotency_key = ${idempotencyKey} LIMIT 1
  `;
  const operationRow = operationRows[0];
  if (operationRow === undefined) return null;
  const taskId = operationRow.task_id;
  const taskRows = typeof taskId === "string"
    ? await sql`SELECT * FROM task_items WHERE id = ${taskId}`
    : [];
  return {
    task: await serializeTaskWithLinkedSession(sql, taskRows[0], {
      registry: options.registry,
    }),
    operation: serializeTaskOperation(operationRow),
    eventId: numberValue(operationRow.actor_event_id) ?? 0,
    idempotent: true,
  };
}

async function recordMutation(
  sql: LivePostgresSql,
  task: Record<string, unknown>,
  input: OperationInput,
  options: CreateLiveTaskMutationProviderOptions,
): Promise<TaskMutationResponse> {
  const recorded = await recordOperation(sql, input);
  return mutationResponse(sql, task, recorded.operation, recorded.eventId, options);
}

async function recordOperation(
  sql: LivePostgresSql,
  input: OperationInput,
): Promise<RecordedOperation> {
  const operationId = randomUUID();
  const operationRows = await sql`
    INSERT INTO task_operations (
      id, task_id, operation_type, actor_session_id,
      idempotency_key, payload_json, reason
    )
    VALUES (
      ${operationId}, ${stringOrNull(input.task?.id)}, ${input.operationType},
      ${input.actorSessionId}, ${input.idempotencyKey ?? null},
      ${jsonString(input.payload)}::jsonb, ${input.reason ?? null}
    )
    RETURNING *
  `;
  const eventRows = await sql`
    SELECT event_append(
      ${input.actorSessionId}, ${"task_operation"},
      ${jsonString({
        operation_id: operationId,
        operation_type: input.operationType,
        task_id: input.task?.id ?? null,
        task: input.task === null ? null : serializeTaskRow(input.task, undefined),
        payload: input.payload,
        reason: input.reason,
      })},
      ${`task operation ${input.operationType} ${String(input.task?.title ?? "")}`.trim()},
      ${new Date().toISOString()},
      ${null}
    ) AS event_id
  `;
  const eventId = numberValue(eventRows[0]?.event_id) ?? 0;
  const updatedRows = await sql`
    UPDATE task_operations SET actor_event_id = ${eventId}
    WHERE id = ${operationId}
    RETURNING *
  `;
  return {
    operation: serializeTaskOperation(updatedRows[0] ?? operationRows[0] ?? {
      id: operationId,
      task_id: input.task?.id ?? null,
      operation_type: input.operationType,
      actor_session_id: input.actorSessionId,
      actor_event_id: eventId,
      idempotency_key: input.idempotencyKey ?? null,
      payload_json: input.payload,
      reason: input.reason ?? null,
    }),
    eventId,
  };
}

async function mutationResponse(
  sql: LivePostgresSql,
  task: Record<string, unknown>,
  operation: SerializedTaskOperation,
  eventId: number,
  options: CreateLiveTaskMutationProviderOptions,
): Promise<TaskMutationResponse> {
  return {
    task: await serializeTaskWithLinkedSession(sql, task, { registry: options.registry }),
    operation,
    eventId,
  };
}

function requireTaskRow(rows: readonly Record<string, unknown>[]): Record<string, unknown> {
  const row = rows[0];
  if (row === undefined) {
    throw new TaskMutationRouteError(500, "task insert did not return a row");
  }
  return row;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberValue(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function jsonString(value: unknown): string {
  return JSON.stringify(jsonCompatible(value));
}

function jsonCompatible(value: unknown): unknown {
  if (value === undefined) return null;
  if (Array.isArray(value)) return value.map((entry) => jsonCompatible(entry));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      jsonCompatible(entry),
    ]),
  );
}
