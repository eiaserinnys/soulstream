import type { Logger } from "pino";

import type { CatalogBoardItemRow, SessionDB } from "../db/session_db.js";

import type { SoulstreamContainerContext } from "./soulstream_item.js";

export interface PrimarySessionContainerContext {
  container: SoulstreamContainerContext;
  sourceRunbookItemId?: string | null;
  runbookGuidance?: string | null;
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

  if (kind === "runbook") {
    const title = await resolveRunbookTitle(db, logger, id, boardItem);
    const container = { kind, id, title };
    return {
      container,
      sourceRunbookItemId: boardItem.sourceRunbookItemId ?? null,
      runbookGuidance: buildRunbookGuidance(container),
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

async function resolveRunbookTitle(
  db: SessionDB,
  logger: Logger,
  runbookId: string,
  boardItem: CatalogBoardItemRow,
): Promise<string> {
  const runbooks = (db as unknown as {
    runbooks?: () => {
      getRunbook?: (runbookId: string) => Promise<{ title?: unknown } | null>;
    };
  }).runbooks;
  if (typeof runbooks === "function") {
    try {
      const repo = runbooks.call(db);
      const runbook = typeof repo.getRunbook === "function"
        ? await repo.getRunbook(runbookId)
        : null;
      if (typeof runbook?.title === "string" && runbook.title.trim().length > 0) {
        return runbook.title;
      }
    } catch (err) {
      logger.warn(
        { err, runbookId },
        "resolveRunbookTitle: getRunbook failed",
      );
    }
  }

  const metadataTitle = boardItem.metadata.title;
  if (typeof metadataTitle === "string" && metadataTitle.trim().length > 0) {
    return metadataTitle;
  }
  return runbookId;
}

function buildRunbookGuidance(container: SoulstreamContainerContext): string {
  return `이 세션은 런북 ${container.id}(${container.title}) 소속. get_runbook으로 체크리스트를 확인하고, 산출물·후속 세션은 이 런북 컨테이너에 연결한다.`;
}
