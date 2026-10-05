import type { RepositorySql } from "./control_plane/card_types.js";

export interface AssignedCardSnapshot {
  capturedAt: string;
  total: number;
  omitted: number;
  cards: Array<{
    id: string; title: string; status: string; hasItems:boolean;
    latestCommentAt: string | null; latestReportAt: string | null;
  }>;
}

/** One bounded server query, scoped by the trusted execution session, never by folder membership. */
export async function readAssignedCardContext(sql: RepositorySql, sessionId: string): Promise<AssignedCardSnapshot> {
  const rows = await sql<Array<{
    id:string; title:string; status:string; total:number; has_items:boolean;
    latest_comment_at:Date|string|null; latest_report_at:Date|string|null;
  }>>`
    WITH assigned AS (
      SELECT id,LEFT(title,161) AS title,status,jsonb_array_length(items)>0 AS has_items,
        count(*) OVER ()::int AS total
      FROM cards WHERE assignee_session_id=${sessionId} AND archived=FALSE
      ORDER BY updated_at DESC,id COLLATE "C" LIMIT 12
    )
    SELECT c.id,c.title,c.status,c.total,c.has_items,
      comment.created_at AS latest_comment_at,
      report.created_at AS latest_report_at
    FROM assigned c
    LEFT JOIN LATERAL (
      SELECT created_at FROM card_comments
      WHERE card_id=c.id AND author_kind='user' AND body ~ '[^[:space:]]'
      ORDER BY created_at DESC,id COLLATE "C" DESC LIMIT 1
    ) comment ON TRUE
    LEFT JOIN LATERAL (
      SELECT created_at FROM card_reports
      WHERE card_id=c.id ORDER BY created_at DESC,id COLLATE "C" DESC LIMIT 1
    ) report ON TRUE
  `;
  const total = rows[0]?.total ?? 0;
  return { capturedAt: new Date().toISOString(), total, omitted: total - rows.length, cards: rows.map(({
    total: _total, has_items, latest_comment_at, latest_report_at, ...card
  }) => ({ ...card, hasItems:has_items, latestCommentAt: iso(latest_comment_at), latestReportAt: iso(latest_report_at) })) };
}

function iso(value: Date | string | null | undefined): string | null {
  return value == null ? null : new Date(value).toISOString();
}
