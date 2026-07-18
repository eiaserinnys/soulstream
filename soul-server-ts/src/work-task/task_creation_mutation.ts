import type { TaskMutationCore } from "./task_mutation_core.js";
import type { TaskRepository } from "./task_repository.js";
import type {
  TaskActorParams,
  TaskMutationResult,
} from "./task_service_models.js";

interface TaskCreationMutationParams {
  actorKind?: TaskActorParams["actorKind"];
  actorSessionId: string | null;
  actorUserId?: string | null;
  idempotencyKey?: string | null;
  taskId: string;
  boardItemId: string;
  folderId: string;
  title: string;
  x: number;
  y: number;
}

export async function mutateTaskCreation(
  core: TaskMutationCore,
  repo: TaskRepository,
  params: TaskCreationMutationParams,
): Promise<TaskMutationResult> {
  const payload = {
    board_item_id: params.boardItemId,
    folder_id: params.folderId,
    title: params.title,
    x: params.x,
    y: params.y,
  };
  if (params.actorSessionId === null) {
    return await core.mutateWithoutSession({
      taskId: params.taskId,
      targetKind: "task",
      targetId: params.taskId,
      operationType: "create_task",
      actor: {
        actorKind: params.actorKind === "system" ? "system" : "user",
        actorSessionId: null,
        actorUserId: params.actorUserId,
      },
      idempotencyKey: params.idempotencyKey,
      payload,
      apply: async (sql) => {
        await repo.createTaskTx(sql, {
          id: params.taskId,
          boardItemId: params.boardItemId,
          title: params.title,
          createdSessionId: null,
          createdEventId: null,
        });
      },
    });
  }
  return await core.mutate({
    taskId: params.taskId,
    targetKind: "task",
    targetId: params.taskId,
    operationType: "create_task",
    actor: {
      actorKind: params.actorKind,
      actorSessionId: params.actorSessionId,
      actorUserId: params.actorUserId,
    },
    idempotencyKey: params.idempotencyKey,
    payload,
    apply: async (sql, eventId) => {
      await repo.createTaskTx(sql, {
        id: params.taskId,
        boardItemId: params.boardItemId,
        title: params.title,
        createdSessionId: params.actorSessionId,
        createdEventId: eventId,
      });
    },
  });
}
