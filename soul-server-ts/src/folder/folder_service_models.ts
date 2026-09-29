import type { FolderOperationActorKind, FolderOperationRow, FolderSnapshot } from "../db/session_db_types.js";

interface FolderMutationBase {
  operation: FolderOperationRow;
  idempotent: boolean;
}

export interface FolderIdentityMutationResult extends FolderMutationBase {
  folder: FolderSnapshot["folder"];
}

export interface ChecklistMutationResult extends FolderMutationBase {
  folderId: string;
  section?: Record<string, unknown> & { id: string } | null;
  item?: Record<string, unknown> & { id: string } | null;
}

export type FolderMutationResult = FolderIdentityMutationResult | ChecklistMutationResult;

export interface FolderActorParams {
  actorKind?: FolderOperationActorKind;
  actorSessionId: string | null;
  actorUserId?: string | null;
}
