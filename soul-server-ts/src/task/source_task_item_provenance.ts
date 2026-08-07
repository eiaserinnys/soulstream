import type { Logger } from "pino";

import type { BoardYjsContainerRef, TaskSnapshot } from "../db/session_db.js";

const REJECTION_MESSAGE =
  "source task item provenance rejected; continuing without provenance";

export async function resolveSourceTaskItemProvenance(params: {
  sessionId: string;
  sourceTaskItemId?: string | null;
  container?: BoardYjsContainerRef | null;
  getTaskSnapshot(taskId: string): Promise<TaskSnapshot | null>;
  logger: Pick<Logger, "warn">;
}): Promise<string | null> {
  const sourceTaskItemId = params.sourceTaskItemId ?? null;
  if (sourceTaskItemId === null) return null;

  const taskId = params.container?.containerKind === "task"
    ? params.container.containerId
    : null;
  if (taskId === null) {
    params.logger.warn({
      sessionId: params.sessionId,
      sourceTaskItemId,
      taskId,
      reason: "task_container_missing",
    }, REJECTION_MESSAGE);
    return null;
  }

  let snapshot: TaskSnapshot | null;
  try {
    snapshot = await params.getTaskSnapshot(taskId);
  } catch (err) {
    params.logger.warn({
      err,
      sessionId: params.sessionId,
      sourceTaskItemId,
      taskId,
      reason: "validation_failed",
    }, REJECTION_MESSAGE);
    return null;
  }

  if (snapshot?.items.some((item) => item.id === sourceTaskItemId)) {
    return sourceTaskItemId;
  }
  params.logger.warn({
    sessionId: params.sessionId,
    sourceTaskItemId,
    taskId,
    reason: "task_item_not_found",
  }, REJECTION_MESSAGE);
  return null;
}
