import type { CatalogBoardItemRow } from "../db/session_db_types.js";

import type { TaskRepository } from "./task_repository.js";
import type { TaskMutationResult } from "./task_service_models.js";

export interface TaskBoardYjsPort {
  upsertTaskBoardItem(input: {
    folderId: string;
    boardItemId: string;
    taskId: string;
    title: string;
    x: number;
    y: number;
    metadata?: Record<string, unknown>;
  }): Promise<CatalogBoardItemRow>;
  removeTaskBoardItem(folderId: string, boardItemId: string): Promise<void>;
}

export async function resolveTaskIdempotent(
  repo: TaskRepository,
  idempotencyKey?: string | null,
): Promise<TaskMutationResult | null> {
  if (!idempotencyKey) return null;
  const operation = await repo.getOperationByIdempotencyKey(idempotencyKey);
  if (!operation?.task_id) return null;
  const snapshot = await repo.getSnapshot(operation.task_id);
  if (!snapshot) throw new Error(`task not found: ${operation.task_id}`);
  return {
    snapshot,
    operation,
    eventId: operation.actor_event_id ?? 0,
    idempotent: true,
  };
}

export async function upsertTaskBoardItem(
  boardYjsService: TaskBoardYjsPort,
  params: {
    folderId: string;
    boardItemId: string;
    taskId: string;
    title: string;
    x: number;
    y: number;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await boardYjsService.upsertTaskBoardItem(params);
}

export async function removeTaskBoardItemIfUnlinked(
  repo: TaskRepository,
  boardYjsService: TaskBoardYjsPort,
  params: {
    folderId: string;
    boardItemId: string;
    taskId: string;
  },
): Promise<void> {
  if (await repo.getTask(params.taskId)) return;
  await boardYjsService.removeTaskBoardItem(params.folderId, params.boardItemId);
}

export async function updateTaskBoardItemTitle(
  repo: TaskRepository,
  boardYjsService: TaskBoardYjsPort,
  taskId: string,
  title: string,
): Promise<void> {
  const boardItem = await repo.getTaskBoardItem(taskId);
  if (!boardItem) throw new Error(`task board item not found: ${taskId}`);
  await boardYjsService.upsertTaskBoardItem({
    folderId: boardItem.folder_id,
    boardItemId: boardItem.id,
    taskId: boardItem.item_id,
    title,
    x: Number(boardItem.x),
    y: Number(boardItem.y),
    metadata: metadataRecord(boardItem.metadata),
  });
}

function metadataRecord(metadata: unknown): Record<string, unknown> {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return {};
  return metadata as Record<string, unknown>;
}
