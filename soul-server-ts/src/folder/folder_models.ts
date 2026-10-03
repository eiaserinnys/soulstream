import type {
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
