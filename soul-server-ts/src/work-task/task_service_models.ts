import type {
  TaskItemStatus,
  FolderOperationActorKind,
  FolderOperationRow,
  FolderSnapshot,
} from "../db/session_db_types.js";

export interface FolderMutationResult {
  snapshot: FolderSnapshot;
  operation: FolderOperationRow;
  eventId: number;
  idempotent?: boolean;
  handoff?: FolderHandoffEvent;
}

export interface FolderActorParams {
  actorKind?: FolderOperationActorKind;
  actorSessionId: string | null;
  actorUserId?: string | null;
}

export interface FolderHandoffEvent {
  folderId: string;
  folderName: string;
  itemId: string;
  itemTitle: string;
  status: Extract<TaskItemStatus, "completed" | "cancelled">;
  operationId: string;
  eventId: number;
}

export interface FolderHandoffNotifierPort {
  notifyHumanHandoff(event: FolderHandoffEvent): void;
}
