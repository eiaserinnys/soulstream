import type { Logger } from "pino";

import type { FolderRow, SessionDB } from "../db/session_db.js";
import type { SessionRow } from "../db/session_db_types.js";
import type { SoulstreamFolderContext } from "./soulstream_item.js";

export type SessionCardRole = "assignee" | "member";

export interface PrimarySessionFolderContext {
  folder: SoulstreamFolderContext;
  card?: { id: string; title: string; status: string; role: SessionCardRole } | null;
}

export async function resolvePrimarySessionFolderContext(
  db: SessionDB,
  logger: Logger,
  sessionId: string,
  folderId?: string,
): Promise<PrimarySessionFolderContext | null> {
  let id = folderId;
  let cardId: string | null = null;
  let session: SessionRow | null = null;
  try {
    session = await db.getSession(sessionId);
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
      const { card: row } = await db.getCard(cardId, sessionId);
      card = { id: row.id, title: row.title, status: row.status, role: resolveCardRole(row, session!, sessionId) };
    } catch (err) {
      logger.warn({ err, sessionId, cardId }, "session card lookup failed");
    }
  }

  return {
    folder: { id: row.id, title: row.name },
    card,
  };
}

/**
 * 표시와 지침 주입(`applies_when.card_role`)에만 쓴다. 권한 판정의 정본은 orch의
 * `claimableCardSessions`(orch-server-ts/src/cards/card_assignee.ts)다.
 */
function resolveCardRole(
  card: Record<string, unknown>,
  session: SessionRow,
  sessionId: string,
): SessionCardRole {
  if (card.assigneeSessionId === sessionId) return "assignee";
  // 자동 배정으로 만들어져 착수하면 담당으로 확정될 세션.
  if (!card.assigneeSessionId && card.assigneeKind === "agent"
    && card.assigneeAgentId === session.agent_id && !session.caller_session_id) return "assignee";
  return "member";
}
