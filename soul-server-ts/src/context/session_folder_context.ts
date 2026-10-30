import type { Logger } from "pino";

import type { FolderRow, SessionDB } from "../db/session_db.js";
import type { SessionRow } from "../db/session_db_types.js";
import type { SoulstreamFolderContext } from "./soulstream_item.js";

export type SessionCardRole = "assignee" | "member";

export interface PrimarySessionFolderContext {
  folder: SoulstreamFolderContext;
  card?: {
    id: string;
    title: string;
    status: string;
    role: SessionCardRole;
    replaced_by?: string;
    notice?: string;
  } | null;
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
      const replacement = session!.card_assignee_replacement;
      const currentAssigneeSessionId = replacement?.current_assignee_session_id;
      card = {
        id: row.id,
        title: row.title,
        status: row.status,
        role: currentAssigneeSessionId ? "member" : resolveCardRole(row, session!, sessionId),
        ...(currentAssigneeSessionId ? {
          replaced_by: currentAssigneeSessionId,
          notice: `이 카드의 담당은 세션 ${currentAssigneeSessionId}로 넘어갔다. 이 카드의 일(카드 도구, 코드 수정, 머지, 배포)을 하지 않는다. 받은 보고나 결과는 ${currentAssigneeSessionId}에 send_message_to_session으로 넘기고 턴을 끝낸다.`,
        } : {}),
      };
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
