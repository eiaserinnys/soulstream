import type { Logger } from "pino";

import type { CatalogBoardItemRow, FolderRow, SessionDB } from "../db/session_db.js";
import type { SoulstreamFolderContext } from "./soulstream_item.js";

export interface PrimarySessionFolderContext {
  folder: SoulstreamFolderContext;
  sourceChecklistItemId?: string | null;
  folderGuidance?: string | null;
}

export async function resolvePrimarySessionFolderContext(
  db: SessionDB,
  logger: Logger,
  sessionId: string,
  folderId?: string,
): Promise<PrimarySessionFolderContext | null> {
  let id = folderId;
  try {
    id ??= (await db.getSession(sessionId))?.folder_id ?? undefined;
  } catch (err) {
    logger.warn({ err, sessionId }, "session folder lookup failed");
    return null;
  }
  if (!id) return null;
  let row: FolderRow | null;
  try {
    row = await db.getFolderById(id);
  } catch (err) {
    logger.warn({ err, sessionId, folderId: id }, "folder lookup failed");
    return null;
  }
  if (!row) return null;

  let boardItem: CatalogBoardItemRow | null = null;
  try {
    boardItem = await db.getPrimarySessionBoardItem(sessionId);
  } catch (err) {
    logger.warn({ err, sessionId }, "primary session board item lookup failed");
  }

  const folder = {
    id: row.id,
    title: row.name,
    checklist_enabled: row.checklist_enabled,
  };
  return {
    folder,
    sourceChecklistItemId: boardItem?.sourceChecklistItemId ?? null,
    ...(row.checklist_enabled ? { folderGuidance: buildFolderGuidance(folder) } : {}),
  };
}

function buildFolderGuidance(folder: SoulstreamFolderContext): string {
  return `이 세션은 폴더 ${folder.id}(${folder.title}) 소속. get_folder로 체크리스트를 확인하고, 산출물·후속 세션은 이 폴더에 연결한다.`;
}
