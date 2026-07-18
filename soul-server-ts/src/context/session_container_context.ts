import type { Logger } from "pino";

import type { CatalogBoardItemRow, SessionDB } from "../db/session_db.js";

import type { SoulstreamContainerContext } from "./soulstream_item.js";

export interface PrimarySessionContainerContext {
  container: SoulstreamContainerContext;
  sourceTaskItemId?: string | null;
  taskGuidance?: string | null;
}

export async function resolvePrimarySessionContainerContext(
  db: SessionDB,
  logger: Logger,
  sessionId: string,
  folderName?: string,
): Promise<PrimarySessionContainerContext | null> {
  const getPrimarySessionBoardItem = (db as unknown as {
    getPrimarySessionBoardItem?: (sessionId: string) => Promise<CatalogBoardItemRow | null>;
  }).getPrimarySessionBoardItem;
  if (typeof getPrimarySessionBoardItem !== "function") return null;

  let boardItem: CatalogBoardItemRow | null;
  try {
    boardItem = await getPrimarySessionBoardItem.call(db, sessionId);
  } catch (err) {
    logger.warn(
      { err, sessionId },
      "resolvePrimarySessionContainerContext: getPrimarySessionBoardItem failed",
    );
    return null;
  }
  if (!boardItem) return null;
  if (boardItem.itemType !== "session" || boardItem.membershipKind !== "primary") {
    return null;
  }

  const kind = boardItem.containerKind ?? "folder";
  const id = boardItem.containerId ?? boardItem.folderId;
  if (!id) return null;

  if (kind === "task") {
    const title = await resolveTaskTitle(db, logger, id, boardItem);
    const container = { kind, id, title };
    return {
      container,
      sourceTaskItemId: boardItem.sourceTaskItemId ?? null,
      taskGuidance: buildTaskGuidance(container),
    };
  }

  return {
    container: {
      kind,
      id,
      title: folderName ?? id,
    },
  };
}

async function resolveTaskTitle(
  db: SessionDB,
  logger: Logger,
  taskId: string,
  boardItem: CatalogBoardItemRow,
): Promise<string> {
  const tasks = (db as unknown as {
    tasks?: () => {
      getTask?: (taskId: string) => Promise<{ title?: unknown } | null>;
    };
  }).tasks;
  if (typeof tasks === "function") {
    try {
      const repo = tasks.call(db);
      const task = typeof repo.getTask === "function"
        ? await repo.getTask(taskId)
        : null;
      if (typeof task?.title === "string" && task.title.trim().length > 0) {
        return task.title;
      }
    } catch (err) {
      logger.warn(
        { err, taskId },
        "resolveTaskTitle: getTask failed",
      );
    }
  }

  const metadataTitle = boardItem.metadata.title;
  if (typeof metadataTitle === "string" && metadataTitle.trim().length > 0) {
    return metadataTitle;
  }
  return taskId;
}

function buildTaskGuidance(container: SoulstreamContainerContext): string {
  return `이 세션은 업무 ${container.id}(${container.title}) 소속. get_task으로 체크리스트를 확인하고, 산출물·후속 세션은 이 업무 컨테이너에 연결한다.`;
}
