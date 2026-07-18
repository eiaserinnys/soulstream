export interface TaskCreatorBoardItemMoverPort {
  moveBoardItemToContainer(params: {
    boardItemId: string;
    target: { containerKind: "task"; containerId: string };
    idempotencyKey: string;
  }): Promise<unknown>;
}

export interface TaskCreatorEnrollmentLoggerPort {
  warn(obj: unknown, msg: string): void;
}

export async function enrollTaskCreatorSession(params: {
  mover?: TaskCreatorBoardItemMoverPort;
  logger?: TaskCreatorEnrollmentLoggerPort;
  actorSessionId: string;
  taskId: string;
}): Promise<boolean> {
  if (!params.mover) return false;
  try {
    // Creating a task is an explicit switch to the newest work unit. Move the
    // caller's primary tile here even when it already belongs to another task.
    await params.mover.moveBoardItemToContainer({
      boardItemId: `session:${params.actorSessionId}`,
      target: { containerKind: "task", containerId: params.taskId },
      idempotencyKey: `task:${params.taskId}:creator:${params.actorSessionId}:enroll`,
    });
    return true;
  } catch (err) {
    params.logger?.warn(
      { err, actorSessionId: params.actorSessionId, taskId: params.taskId },
      "task creator session enrollment failed",
    );
    return false;
  }
}
