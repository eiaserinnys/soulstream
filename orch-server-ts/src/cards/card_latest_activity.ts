import type { LivePostgresSql } from "../runtime/live_db_sql.js";

/** Add previews only for identities already selected by the caller's read/access policy. */
export async function projectCardActivity<T extends Record<string, unknown>>(sql: LivePostgresSql, cards: readonly T[]) {
  if (!cards.length) return [];
  const ids = cards.map(card => String(card.id));
  const activities = await sql`
    WITH candidates AS (
      SELECT id AS card_id, id, 'instruction'::text AS kind, 'markdown'::text AS format, request AS body, created_at
        FROM cards WHERE id = ANY(${ids}::text[])
      UNION ALL
      SELECT card_id, id, 'instruction', 'markdown', body, created_at
        FROM card_comments WHERE card_id = ANY(${ids}::text[]) AND author_kind = 'user'
      UNION ALL
      SELECT card_id, id, 'report', format, body, created_at
        FROM card_reports WHERE card_id = ANY(${ids}::text[])
    )
    SELECT DISTINCT ON (card_id) card_id, kind, format, body, created_at FROM candidates
      WHERE body ~ '[^[:space:]]'
      ORDER BY card_id, created_at DESC, id COLLATE "C" DESC, kind DESC
  `;
  const byId = new Map(activities.map(activity => [String(activity.card_id), {
    kind: activity.kind as "instruction" | "report", format: activity.format as "markdown" | "html",
    body: String(activity.body), createdAt: new Date(activity.created_at as Date | string).toISOString(),
  }]));
  return cards.map(card => ({ ...card, latest_activity: byId.get(String(card.id)) ?? null }));
}
