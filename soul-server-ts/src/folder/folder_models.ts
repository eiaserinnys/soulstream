import type {
  ChecklistAssigneeFields,
  FolderOperationTargetKind,
} from "../db/session_db_types.js";

export class FolderVersionConflict extends Error {
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
    this.name = "FolderVersionConflict";
  }
}

export class EmptyChecklistPatchError extends Error {
  readonly statusCode = 422;

  constructor(public readonly targetKind: FolderOperationTargetKind) {
    super(`checklist ${targetKind} patch requires at least one field to update`);
    this.name = "EmptyChecklistPatchError";
  }
}

export interface ChecklistAssigneeInput {
  kind: ChecklistAssigneeFields["assignee_kind"];
  agentId?: string | null;
  sessionId?: string | null;
  userId?: string | null;
}
