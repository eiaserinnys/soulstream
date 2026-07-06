export interface RunbookCreatorBoardItemMoverPort {
  moveBoardItemToContainer(params: {
    boardItemId: string;
    target: { containerKind: "runbook"; containerId: string };
    idempotencyKey: string;
  }): Promise<unknown>;
}

export interface RunbookCreatorEnrollmentLoggerPort {
  warn(obj: unknown, msg: string): void;
}

export async function enrollRunbookCreatorSession(params: {
  mover?: RunbookCreatorBoardItemMoverPort;
  logger?: RunbookCreatorEnrollmentLoggerPort;
  actorSessionId: string;
  runbookId: string;
}): Promise<boolean> {
  if (!params.mover) return false;
  try {
    // Creating a runbook is an explicit switch to the newest work unit. Move the
    // caller's primary tile here even when it already belongs to another runbook.
    await params.mover.moveBoardItemToContainer({
      boardItemId: `session:${params.actorSessionId}`,
      target: { containerKind: "runbook", containerId: params.runbookId },
      idempotencyKey: `runbook:${params.runbookId}:creator:${params.actorSessionId}:enroll`,
    });
    return true;
  } catch (err) {
    params.logger?.warn(
      { err, actorSessionId: params.actorSessionId, runbookId: params.runbookId },
      "runbook creator session enrollment failed",
    );
    return false;
  }
}
