import type { RepositorySql } from "./card_types.js";
import type { CardItemSource } from "../card_item_rules.js";

export async function readCardItemSourceTx(
  sql: RepositorySql,
  cardId: string,
  commentId: string,
): Promise<CardItemSource | null> {
  const row = (await sql<{ id: string; kind: "comment" | "spoken"; created_at: Date }[]>`
    SELECT id,kind,created_at FROM card_comments
    WHERE card_id=${cardId} AND id=${commentId} AND author_kind='user' AND kind IN ('comment','spoken')
  `)[0];
  return row ? { commentId: row.id, kind: row.kind, at: row.created_at.toISOString() } : null;
}

export async function hasUserInputAfterLastReplyTx(sql: RepositorySql, cardId: string): Promise<boolean> {
  const row = (await sql<{ has_user_input: boolean }[]>`
    WITH last_reply AS (
      SELECT MAX(created_at) AS at FROM card_comments
      WHERE card_id=${cardId} AND author_kind='agent' AND kind='comment'
    )
    SELECT EXISTS (
      SELECT 1 FROM last_reply
      WHERE EXISTS (
        SELECT 1 FROM card_comments c
        WHERE c.card_id=${cardId} AND c.author_kind='user' AND c.kind IN ('comment','spoken')
          AND (last_reply.at IS NULL OR c.created_at > last_reply.at)
      ) OR EXISTS (
        SELECT 1 FROM card_questions q
        WHERE q.card_id=${cardId} AND q.answer IS NOT NULL
          AND (last_reply.at IS NULL OR q.answered_at > last_reply.at)
      )
    ) AS has_user_input
  `)[0];
  return row?.has_user_input === true;
}
