import { randomUUID } from "node:crypto";
import { applyCardMoveTx } from "../cards/control_plane/card_move.js";
import type { CardRow } from "../cards/control_plane/card_types.js";
import { appendFolderOperation } from "../folders/folder_operation_store.js";
import type { MovedAssignedCard, SessionTreeMoveCommit } from "./session_folder_move_service.js";
import type { LiveDbSqlResolver } from "../runtime/live_db_sql.js";
import { FolderContentSqlResolver } from "../board/folder_content_sql.js";

export class SessionFolderMoveRepository {
  private readonly sqlResolver: FolderContentSqlResolver;

  constructor(resolver: LiveDbSqlResolver) {
    this.sqlResolver = new FolderContentSqlResolver(resolver);
  }

  async listSessionMoveTree(sessionIds: readonly string[]): Promise<string[]> {
    const sql = await this.sqlResolver.resolveSql();
    const rows = await sql<{ session_id: string }[]>`
      WITH RECURSIVE tree AS (
        SELECT session_id FROM sessions WHERE session_id = ANY(${sql.array(sessionIds)}::text[])
        UNION
        SELECT child.session_id FROM sessions child JOIN tree ON child.caller_session_id = tree.session_id
      )
      SELECT session_id FROM tree ORDER BY session_id
    `;
    return rows.map(row => row.session_id);
  }

  async areSessionAssignmentsInFolder(sessionIds: readonly string[], folderId: string | null): Promise<boolean> {
    const sql = await this.sqlResolver.resolveSql();
    const rows = await sql<{ unchanged: boolean }[]>`
      SELECT (
        (SELECT COUNT(*) = cardinality(${sql.array(sessionIds)}::text[])
          AND COALESCE(bool_and(folder_id IS NOT DISTINCT FROM ${folderId}), false)
         FROM sessions WHERE session_id = ANY(${sql.array(sessionIds)}::text[]))
        AND NOT EXISTS (
          SELECT 1 FROM cards
          WHERE assignee_session_id = ANY(${sql.array(sessionIds)}::text[])
            AND folder_id IS DISTINCT FROM ${folderId}
        )
      ) AS unchanged
    `;
    return rows[0]!.unchanged;
  }

  async commitSessionMove(input: {
    sessionId: string;
    sessionIds: readonly string[];
    folderId: string | null;
  }): Promise<SessionTreeMoveCommit> {
    const sql = await this.sqlResolver.resolveSql();
    return await sql.begin(async (transaction) => {
      const sessions = await transaction<{folder_id:string|null}[]>`
        SELECT folder_id FROM sessions WHERE session_id = ANY(${transaction.array(input.sessionIds)}::text[])
        ORDER BY session_id FOR UPDATE
      `;
      const cards = await transaction<CardRow[]>`
        SELECT * FROM cards WHERE assignee_session_id = ANY(${transaction.array(input.sessionIds)}::text[])
        ORDER BY id FOR UPDATE
      `;
      if (cards.length && input.folderId === null) {
        throw Object.assign(new Error("Assigned cards require a destination folder"), { statusCode: 422 });
      }
      for (const sessionId of input.sessionIds) {
        await transaction`SELECT session_assign_folder(${sessionId}, ${input.folderId})`;
      }
      const movedCards: MovedAssignedCard[] = [];
      for (const card of cards) {
        if (card.folder_id === input.folderId) continue;
        await applyCardMoveTx(transaction, card, input.folderId!, null, { actorSessionId: null }, null);
        await appendFolderOperation(transaction, {
          id: randomUUID(), folderId: card.folder_id, targetKind: "card", targetId: card.id,
          operationType: "move_card", actorKind: "system", actorEventId: null,
          payload: { folder_id: input.folderId, after_card_id: null },
          reason: "Session tree folder move",
        });
        movedCards.push({ cardId: card.id, sourceFolderId: card.folder_id, folderId: input.folderId! });
      }
      return {cards:movedCards,folderIds:[...new Set([
        ...sessions.map(session=>session.folder_id),input.folderId,
        ...movedCards.map(card=>card.sourceFolderId),
      ].filter((id):id is string=>id!==null))]};
    });
  }

}
