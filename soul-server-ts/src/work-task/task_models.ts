import type {
  TaskAssigneeFields,
  TaskOperationRow,
  TaskOperationActorKind,
  TaskOperationTargetKind,
} from "../db/session_db_types.js";
import { recordFromDb } from "../db/repositories/repository_helpers.js";

export class TaskVersionConflict extends Error {
  readonly statusCode = 409;

  constructor(
    public readonly targetKind: TaskOperationTargetKind,
    public readonly targetId: string,
    public readonly expectedVersion: number,
    public readonly actualVersion: number,
  ) {
    super(
      `task ${targetKind} version conflict: ${targetId} expected version ${expectedVersion}, actual version ${actualVersion}`,
    );
    this.name = "TaskVersionConflict";
  }
}

export interface TaskAssigneeInput {
  kind: TaskAssigneeFields["assignee_kind"];
  agentId?: string | null;
  sessionId?: string | null;
  userId?: string | null;
}

export interface AppendTaskOperationTxParams {
  id: string;
  taskId: string;
  targetKind: TaskOperationTargetKind;
  targetId: string;
  operationType: string;
  actorKind: TaskOperationActorKind;
  actorSessionId?: string | null;
  actorEventId: number | null;
  actorUserId?: string | null;
  idempotencyKey?: string | null;
  payload: Record<string, unknown>;
  reason?: string | null;
}

export function assigneeToFields(
  assignee?: TaskAssigneeInput | null,
): TaskAssigneeFields {
  if (!assignee?.kind) {
    return {
      assignee_kind: null,
      assignee_agent_id: null,
      assignee_session_id: null,
      assignee_user_id: null,
    };
  }
  return {
    assignee_kind: assignee.kind,
    assignee_agent_id: assignee.kind === "agent" ? assignee.agentId ?? null : null,
    assignee_session_id: assignee.kind === "session" ? assignee.sessionId ?? null : null,
    assignee_user_id: assignee.kind === "human" ? assignee.userId ?? null : null,
  };
}

export function cleanPatch<T extends Record<string, unknown>>(fields: T): T {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  ) as T;
}

export function normalizeOperation(row: TaskOperationRow): TaskOperationRow {
  return { ...row, payload_json: recordFromDb(row.payload_json) };
}

export function requireOne<T>(rows: T[], op: string): T {
  const row = rows[0];
  if (!row) throw new Error(`${op} returned no rows`);
  return row;
}
