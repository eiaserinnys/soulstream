import type {
  RunbookAssigneeFields,
  RunbookOperationRow,
  RunbookOperationActorKind,
  RunbookOperationTargetKind,
} from "../db/session_db_types.js";
import { recordFromDb } from "../db/repositories/repository_helpers.js";

export class RunbookVersionConflict extends Error {
  readonly statusCode = 409;

  constructor(
    public readonly targetKind: RunbookOperationTargetKind,
    public readonly targetId: string,
    public readonly expectedVersion: number,
    public readonly actualVersion: number,
  ) {
    super(
      `runbook ${targetKind} version conflict: ${targetId} expected version ${expectedVersion}, actual version ${actualVersion}`,
    );
    this.name = "RunbookVersionConflict";
  }
}

export interface RunbookAssigneeInput {
  kind: RunbookAssigneeFields["assignee_kind"];
  agentId?: string | null;
  sessionId?: string | null;
  userId?: string | null;
}

export interface AppendRunbookOperationTxParams {
  id: string;
  runbookId: string;
  targetKind: RunbookOperationTargetKind;
  targetId: string;
  operationType: string;
  actorKind: RunbookOperationActorKind;
  actorSessionId?: string | null;
  actorEventId: number;
  actorUserId?: string | null;
  idempotencyKey?: string | null;
  payload: Record<string, unknown>;
  reason?: string | null;
}

export function assigneeToFields(
  assignee?: RunbookAssigneeInput | null,
): RunbookAssigneeFields {
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

export function normalizeOperation(row: RunbookOperationRow): RunbookOperationRow {
  return { ...row, payload_json: recordFromDb(row.payload_json) };
}

export function requireOne<T>(rows: T[], op: string): T {
  const row = rows[0];
  if (!row) throw new Error(`${op} returned no rows`);
  return row;
}
