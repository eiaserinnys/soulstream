import type {
  TaskItemStatus,
  TaskOperationActorKind,
  TaskOperationRow,
  TaskSnapshot,
} from "../db/session_db_types.js";

export interface TaskMutationResult {
  snapshot: TaskSnapshot;
  operation: TaskOperationRow;
  eventId: number;
  idempotent?: boolean;
  handoff?: TaskHandoffEvent;
}

export interface TaskActorParams {
  actorKind?: TaskOperationActorKind;
  actorSessionId: string | null;
  actorUserId?: string | null;
}

export interface TaskHandoffEvent {
  taskId: string;
  taskTitle: string;
  boardItemId: string;
  itemId: string;
  itemTitle: string;
  status: Extract<TaskItemStatus, "completed" | "cancelled">;
  operationId: string;
  eventId: number;
}

export interface TaskHandoffNotifierPort {
  notifyHumanHandoff(event: TaskHandoffEvent): void;
}
