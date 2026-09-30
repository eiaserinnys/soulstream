import type { Logger } from "pino";

import type { FolderRow, SessionDB } from "../db/session_db.js";
import type { SoulstreamFolderContext } from "./soulstream_item.js";

export interface PrimarySessionFolderContext {
  folder: SoulstreamFolderContext;
  card?: { id: string; title: string; status: string } | null;
  cardGuidance?: string | null;
  folderGuidance?: string | null;
}

export async function resolvePrimarySessionFolderContext(
  db: SessionDB,
  logger: Logger,
  sessionId: string,
  folderId?: string,
): Promise<PrimarySessionFolderContext | null> {
  let id = folderId;
  let cardId: string | null = null;
  try {
    const session = await db.getSession(sessionId);
    id ??= session?.folder_id ?? undefined;
    cardId = session?.card_id ?? null;
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

  let card: PrimarySessionFolderContext["card"] = null;
  if (cardId) {
    try {
      const snapshot = await db.getFolderSnapshot(id);
      const row = snapshot?.cards.find(candidate => candidate.id === cardId);
      if (row) card = { id: row.id, title: row.title, status: row.status };
    } catch (err) {
      logger.warn({ err, sessionId, cardId }, "session card lookup failed");
    }
  }

  const folder = {
    id: row.id,
    title: row.name,
    checklist_enabled: row.checklist_enabled,
  };
  return {
    folder,
    card,
    ...(card ? { cardGuidance: `이 세션은 카드 ${card.id}를 맡았다. 경과는 update_card_brief, 보고는 add_card_report, 검수는 request_card_review, 질문은 ask_card_question으로 남긴다. AskUserQuestion은 쓰지 않는다.` } : {}),
    folderGuidance: buildFolderGuidance(folder),
  };
}

function buildFolderGuidance(folder: SoulstreamFolderContext): string {
  return `이 세션은 폴더 ${folder.id}(${folder.title}) 소속. get_folder로 카드를 확인하고, 산출물·후속 세션은 이 폴더에 연결한다.`;
}
