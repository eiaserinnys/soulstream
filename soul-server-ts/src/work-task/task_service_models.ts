import type { AppendEventParams } from "../db/session_db.js";
import type { RepositorySql } from "../db/repositories/repository_helpers.js";
import type {
  TaskItemStatus,
  TaskOperationActorKind,
  TaskOperationRow,
  TaskSnapshot,
} from "../db/session_db_types.js";

import type { TaskRepository } from "./task_repository.js";

export interface TaskDbPort {
  tasks(): TaskRepository;
  appendEventTx(sql: RepositorySql, params: AppendEventParams): Promise<number>;
  getCatalog(): Promise<unknown>;
}

export interface TaskBroadcasterPort {
  emitTaskUpdated(
    agentSessionId: string,
    taskId: string,
    boardItemId: string,
  ): Promise<void>;
  emitCatalogUpdated?(catalog: unknown): Promise<void>;
}

export interface TaskMutationResult {
  snapshot: TaskSnapshot;
  operation: TaskOperationRow;
  eventId: number;
  idempotent?: boolean;
}

export interface TaskActorParams {
  actorKind?: TaskOperationActorKind;
  actorSessionId: string;
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
