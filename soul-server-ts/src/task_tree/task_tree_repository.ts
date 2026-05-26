import type { SqlClient } from "../db/session_db.js";

export const TASK_STATUSES = [
  "open",
  "in_progress",
  "agent_done",
  "verified_done",
  "reopened",
  "blocked",
  "cancelled",
] as const;

export type TaskTreeStatus = (typeof TASK_STATUSES)[number];
export type VerificationOwner = "agent" | "user" | "both";

export interface TaskItemRow {
  id: string;
  parent_id: string | null;
  position_key: number;
  title: string;
  description: string;
  acceptance_criteria: string;
  verification_owner: VerificationOwner;
  status: TaskTreeStatus;
  linked_session_id: string | null;
  linked_node_id: string | null;
  active_for_session_id: string | null;
  created_from_session_id: string | null;
  created_from_event_id: number | null;
  navigation_session_id: string | null;
  navigation_node_id: string | null;
  navigation_event_id: number | null;
  archived: boolean;
  pinned: boolean;
  version: number;
  created_at: Date;
  updated_at: Date;
}

export interface TaskOperationRow {
  id: string;
  task_id: string | null;
  operation_type: string;
  actor_kind: string;
  actor_session_id: string | null;
  actor_event_id: number | null;
  actor_user_id: string | null;
  idempotency_key: string | null;
  payload_json: Record<string, unknown>;
  reason: string | null;
  created_at: Date;
}

export interface CreateTaskItemParams {
  id: string;
  parentId?: string | null;
  positionKey: number;
  title: string;
  description?: string;
  acceptanceCriteria?: string;
  verificationOwner?: VerificationOwner;
  status?: TaskTreeStatus;
  linkedSessionId?: string | null;
  linkedNodeId?: string | null;
  activeForSessionId?: string | null;
  createdFromSessionId?: string | null;
  navigationSessionId?: string | null;
  navigationNodeId?: string | null;
  navigationEventId?: number | null;
}

export interface PatchTaskItemParams {
  parent_id?: string | null;
  position_key?: number;
  title?: string;
  description?: string;
  acceptance_criteria?: string;
  verification_owner?: VerificationOwner;
  status?: TaskTreeStatus;
  linked_session_id?: string | null;
  linked_node_id?: string | null;
  active_for_session_id?: string | null;
  created_from_session_id?: string | null;
  created_from_event_id?: number | null;
  navigation_session_id?: string | null;
  navigation_node_id?: string | null;
  navigation_event_id?: number | null;
  archived?: boolean;
  pinned?: boolean;
}

export interface AppendTaskOperationParams {
  id: string;
  taskId: string | null;
  operationType: string;
  actorKind?: string;
  actorSessionId: string;
  actorUserId?: string | null;
  idempotencyKey?: string | null;
  payload: Record<string, unknown>;
  reason?: string | null;
}

export class TaskTreeRepository {
  constructor(private readonly sql: SqlClient) {}

  async createTaskItem(params: CreateTaskItemParams): Promise<TaskItemRow> {
    const rows = await this.sql<TaskItemRow[]>`
      INSERT INTO task_items (
        id,
        parent_id,
        position_key,
        title,
        description,
        acceptance_criteria,
        verification_owner,
        status,
        linked_session_id,
        linked_node_id,
        active_for_session_id,
        created_from_session_id,
        navigation_session_id,
        navigation_node_id,
        navigation_event_id
      )
      VALUES (
        ${params.id},
        ${params.parentId ?? null},
        ${params.positionKey},
        ${params.title},
        ${params.description ?? ""},
        ${params.acceptanceCriteria ?? ""},
        ${params.verificationOwner ?? "agent"},
        ${params.status ?? "open"},
        ${params.linkedSessionId ?? null},
        ${params.linkedNodeId ?? null},
        ${params.activeForSessionId ?? null},
        ${params.createdFromSessionId ?? null},
        ${params.navigationSessionId ?? null},
        ${params.navigationNodeId ?? null},
        ${params.navigationEventId ?? null}
      )
      RETURNING *
    `;
    return requireOne(rows, "createTaskItem");
  }

  async getTaskItem(taskId: string): Promise<TaskItemRow | null> {
    const rows = await this.sql<TaskItemRow[]>`
      SELECT * FROM task_items WHERE id = ${taskId}
    `;
    return rows[0] ?? null;
  }

  async listTaskItems(params: {
    includeArchived?: boolean;
    status?: TaskTreeStatus;
    linkedSessionId?: string;
    rootTaskId?: string;
    limit?: number;
  } = {}): Promise<TaskItemRow[]> {
    const limit = Math.min(Math.max(params.limit ?? 500, 1), 1000);
    if (params.rootTaskId) {
      return await this.sql<TaskItemRow[]>`
        WITH RECURSIVE subtree AS (
          SELECT * FROM task_items WHERE id = ${params.rootTaskId}
          UNION ALL
          SELECT child.*
          FROM task_items child
          JOIN subtree parent ON child.parent_id = parent.id
        )
        SELECT * FROM subtree
        WHERE (${params.includeArchived ?? false} OR archived = FALSE)
          AND (${params.status ?? null}::text IS NULL OR status = ${params.status ?? null})
          AND (${params.linkedSessionId ?? null}::text IS NULL OR linked_session_id = ${params.linkedSessionId ?? null})
        ORDER BY parent_id NULLS FIRST, position_key ASC, created_at ASC
        LIMIT ${limit}
      `;
    }

    return await this.sql<TaskItemRow[]>`
      SELECT * FROM task_items
      WHERE (${params.includeArchived ?? false} OR archived = FALSE)
        AND (${params.status ?? null}::text IS NULL OR status = ${params.status ?? null})
        AND (${params.linkedSessionId ?? null}::text IS NULL OR linked_session_id = ${params.linkedSessionId ?? null})
      ORDER BY parent_id NULLS FIRST, position_key ASC, created_at ASC
      LIMIT ${limit}
    `;
  }

  async searchTaskItems(params: {
    query?: string;
    status?: TaskTreeStatus;
    limit?: number;
  }): Promise<TaskItemRow[]> {
    const query = params.query?.trim();
    const like = query ? `%${query}%` : null;
    const limit = Math.min(Math.max(params.limit ?? 50, 1), 200);
    return await this.sql<TaskItemRow[]>`
      SELECT *
      FROM task_items
      WHERE archived = FALSE
        AND (${params.status ?? null}::text IS NULL OR status = ${params.status ?? null})
        AND (
          ${like}::text IS NULL
          OR title ILIKE ${like}
          OR description ILIKE ${like}
          OR acceptance_criteria ILIKE ${like}
        )
      ORDER BY updated_at DESC
      LIMIT ${limit}
    `;
  }

  async patchTaskItem(
    taskId: string,
    fields: PatchTaskItemParams,
    expectedVersion?: number | null,
  ): Promise<TaskItemRow> {
    const clean = Object.fromEntries(
      Object.entries(fields).filter(([, value]) => value !== undefined),
    ) as PatchTaskItemParams;
    if (Object.keys(clean).length === 0) {
      const existing = await this.getTaskItem(taskId);
      if (!existing) throw new Error(`task item not found: ${taskId}`);
      return existing;
    }

    const rows = await this.sql<TaskItemRow[]>`
      UPDATE task_items
      SET ${this.sql(clean)},
          updated_at = NOW(),
          version = version + 1
      WHERE id = ${taskId}
        AND (${expectedVersion ?? null}::integer IS NULL OR version = ${expectedVersion ?? null})
      RETURNING *
    `;
    if (rows.length === 0) {
      throw new Error(`task item not found or version mismatch: ${taskId}`);
    }
    return rows[0] as TaskItemRow;
  }

  async clearActiveTaskForSession(sessionId: string): Promise<void> {
    await this.sql`
      UPDATE task_items
      SET active_for_session_id = NULL,
          updated_at = NOW(),
          version = version + 1
      WHERE active_for_session_id = ${sessionId}
    `;
  }

  async getActiveTaskForSession(sessionId: string): Promise<TaskItemRow | null> {
    const rows = await this.sql<TaskItemRow[]>`
      SELECT * FROM task_items
      WHERE active_for_session_id = ${sessionId}
        AND archived = FALSE
      ORDER BY updated_at DESC
      LIMIT 1
    `;
    return rows[0] ?? null;
  }

  async getTaskPath(taskId: string): Promise<TaskItemRow[]> {
    return await this.sql<TaskItemRow[]>`
      WITH RECURSIVE ancestors AS (
        SELECT *, 0 AS depth FROM task_items WHERE id = ${taskId}
        UNION ALL
        SELECT parent.*, child.depth + 1
        FROM task_items parent
        JOIN ancestors child ON child.parent_id = parent.id
      )
      SELECT id, parent_id, position_key, title, description,
             acceptance_criteria, verification_owner, status,
             linked_session_id, linked_node_id, active_for_session_id,
             created_from_session_id, created_from_event_id,
             navigation_session_id, navigation_node_id, navigation_event_id,
             archived, pinned, version, created_at, updated_at
      FROM ancestors
      ORDER BY depth DESC
    `;
  }

  async wouldCreateCycle(
    taskId: string,
    candidateParentId: string | null,
  ): Promise<boolean> {
    if (!candidateParentId) return false;
    if (taskId === candidateParentId) return true;
    const rows = await this.sql<Array<{ found: boolean }>>`
      WITH RECURSIVE descendants AS (
        SELECT id FROM task_items WHERE parent_id = ${taskId}
        UNION ALL
        SELECT child.id
        FROM task_items child
        JOIN descendants d ON child.parent_id = d.id
      )
      SELECT EXISTS (
        SELECT 1 FROM descendants WHERE id = ${candidateParentId}
      ) AS found
    `;
    return rows[0]?.found === true;
  }

  async nextPositionKey(parentId: string | null): Promise<number> {
    const rows = await this.sql<Array<{ next_position: number | null }>>`
      SELECT COALESCE(MAX(position_key), 0) + 1 AS next_position
      FROM task_items
      WHERE (
        (${parentId}::text IS NULL AND parent_id IS NULL)
        OR parent_id = ${parentId}
      )
    `;
    return Number(rows[0]?.next_position ?? 1);
  }

  async appendTaskOperation(
    params: AppendTaskOperationParams,
  ): Promise<TaskOperationRow> {
    const rows = await this.sql<TaskOperationRow[]>`
      INSERT INTO task_operations (
        id,
        task_id,
        operation_type,
        actor_kind,
        actor_session_id,
        actor_user_id,
        idempotency_key,
        payload_json,
        reason
      )
      VALUES (
        ${params.id},
        ${params.taskId},
        ${params.operationType},
        ${params.actorKind ?? "agent"},
        ${params.actorSessionId},
        ${params.actorUserId ?? null},
        ${params.idempotencyKey ?? null},
        ${this.sql.json(params.payload as never)},
        ${params.reason ?? null}
      )
      RETURNING *
    `;
    return normalizeOperation(requireOne(rows, "appendTaskOperation"));
  }

  async setTaskOperationEventId(
    operationId: string,
    eventId: number,
  ): Promise<TaskOperationRow> {
    const rows = await this.sql<TaskOperationRow[]>`
      UPDATE task_operations
      SET actor_event_id = ${eventId}
      WHERE id = ${operationId}
      RETURNING *
    `;
    return normalizeOperation(requireOne(rows, "setTaskOperationEventId"));
  }

  async getTaskOperationByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<TaskOperationRow | null> {
    const rows = await this.sql<TaskOperationRow[]>`
      SELECT * FROM task_operations
      WHERE idempotency_key = ${idempotencyKey}
      LIMIT 1
    `;
    const row = rows[0];
    return row ? normalizeOperation(row) : null;
  }

  async listTaskOperations(
    taskId: string,
    limit = 50,
  ): Promise<TaskOperationRow[]> {
    return (
      await this.sql<TaskOperationRow[]>`
        SELECT * FROM task_operations
        WHERE task_id = ${taskId}
        ORDER BY created_at DESC
        LIMIT ${Math.min(Math.max(limit, 1), 200)}
      `
    ).map(normalizeOperation);
  }
}

function normalizeOperation(row: TaskOperationRow): TaskOperationRow {
  return {
    ...row,
    payload_json:
      row.payload_json && typeof row.payload_json === "object"
        ? row.payload_json
        : {},
  };
}

function requireOne<T>(rows: T[], op: string): T {
  const row = rows[0];
  if (!row) {
    throw new Error(`${op} returned no rows`);
  }
  return row;
}
