import type { FolderOperationActorKind, FolderOperationRow, FolderSnapshot } from "../db/session_db_types.js";

interface FolderMutationBase {
  operation: FolderOperationRow;
  idempotent: boolean;
}

export interface FolderIdentityMutationResult extends FolderMutationBase {
  folder: FolderSnapshot["folder"];
}

export interface CardMutationResult extends FolderMutationBase {
  folderId: string;
  card?: Record<string, unknown> & { id: string } | null;
}

export type FolderMutationResult = FolderIdentityMutationResult | CardMutationResult;

export interface FolderActorParams {
  actorKind?: FolderOperationActorKind;
  actorSessionId: string | null;
  actorUserId?: string | null;
}
