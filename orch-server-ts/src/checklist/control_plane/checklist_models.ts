import type {
  ChecklistAssigneeFields,
  FolderOperationRow,
  FolderOperationActorKind,
  FolderOperationTargetKind,
} from "./checklist_types.js";
import { recordFromDb } from "./repository_helpers.js";

export class ChecklistVersionConflict extends Error {
  readonly statusCode = 409;

  constructor(
    public readonly targetKind: FolderOperationTargetKind,
    public readonly targetId: string,
    public readonly expectedVersion: number,
    public readonly actualVersion: number,
  ) {
    super(
      `folder ${targetKind} version conflict: ${targetId} expected version ${expectedVersion}, actual version ${actualVersion}`,
    );
    this.name = "ChecklistVersionConflict";
  }
}

export class EmptyFolderPatchError extends Error {
  readonly statusCode = 422;

  constructor(public readonly targetKind: FolderOperationTargetKind) {
    super(`folder ${targetKind} patch requires at least one field to update`);
    this.name = "EmptyFolderPatchError";
  }
}

export function assertFolderPatchHasFields(
  targetKind: FolderOperationTargetKind,
  fields: Record<string, unknown>,
): void {
  if (Object.values(fields).every((value) => value === undefined)) {
    throw new EmptyFolderPatchError(targetKind);
  }
}

export interface ChecklistAssigneeInput {
  kind: ChecklistAssigneeFields["assignee_kind"];
  agentId?: string | null;
  sessionId?: string | null;
  userId?: string | null;
}

export interface AppendFolderOperationTxParams {
  id: string;
  folderId: string;
  targetKind: FolderOperationTargetKind;
  targetId: string;
  operationType: string;
  actorKind: FolderOperationActorKind;
  actorSessionId?: string | null;
  actorEventId: number | null;
  actorUserId?: string | null;
  idempotencyKey?: string | null;
  payload: Record<string, unknown>;
  reason?: string | null;
}

export function assigneeToFields(
  assignee?: ChecklistAssigneeInput | null,
): ChecklistAssigneeFields {
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

export function normalizeOperation(row: FolderOperationRow): FolderOperationRow {
  return { ...row, payload_json: recordFromDb(row.payload_json) };
}

export function requireOne<T>(rows: T[], op: string): T {
  const row = rows[0];
  if (!row) throw new Error(`${op} returned no rows`);
  return row;
}
