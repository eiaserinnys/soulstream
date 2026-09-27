import type {
  TaskAssigneeFields,
  TaskOperationTargetKind,
} from "../db/session_db_types.js";

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

export class EmptyTaskPatchError extends Error {
  readonly statusCode = 422;

  constructor(public readonly targetKind: TaskOperationTargetKind) {
    super(`task ${targetKind} patch requires at least one field to update`);
    this.name = "EmptyTaskPatchError";
  }
}

export interface TaskAssigneeInput {
  kind: TaskAssigneeFields["assignee_kind"];
  agentId?: string | null;
  sessionId?: string | null;
  userId?: string | null;
}
