import type { RepositorySql } from "./control_plane/card_types.js";

export interface AssignedCardSnapshot {
  capturedAt: string;
  total: number;
  omitted: number;
  cards: Array<{ id: string; title: string; status: string; version: number; instruction: string; report: string }>;
}

/** One bounded server query, scoped by the trusted execution session, never by folder membership. */
export async function readAssignedCardContext(sql: RepositorySql, sessionId: string): Promise<AssignedCardSnapshot> {
  const rows = await sql<Array<{ id:string; title:string; status:string; version:number; instruction:string; report:string; total:number }>>`
    WITH assigned AS (
      SELECT id,LEFT(title,161) AS title,status,version,LEFT(request,401) AS request,created_at,
        count(*) OVER ()::int AS total
      FROM cards WHERE assignee_session_id=${sessionId} AND archived=FALSE
        AND status NOT IN ('done','cancelled')
      ORDER BY updated_at DESC,id COLLATE "C" LIMIT 12
    )
    SELECT c.id,c.title,c.status,c.version,c.total,
      COALESCE((SELECT LEFT(body,401) FROM card_comments WHERE card_id=c.id AND author_kind='user'
        AND body ~ '[^[:space:]]' ORDER BY created_at DESC,id COLLATE "C" DESC LIMIT 1),c.request) AS instruction,
      COALESCE((SELECT LEFT(regexp_replace(body,'<[^>]*>',' ','g'),401) FROM card_reports WHERE card_id=c.id
        ORDER BY created_at DESC,id COLLATE "C" DESC LIMIT 1),'') AS report
    FROM assigned c
  `;
  const total = rows[0]?.total ?? 0;
  return { capturedAt: new Date().toISOString(), total, omitted: total - rows.length, cards: rows.map(({total, ...card}) => card) };
}
