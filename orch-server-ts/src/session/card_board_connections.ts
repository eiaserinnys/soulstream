import { readPersistentEnabled } from "@soulstream/wire-schema/persistent-session-settings";
import type { RepositorySql,SqlClient } from "../cards/control_plane/card_types.js";
import type { BoardCard } from "./card_board_entries.js";
// Both directions use exactly the same creator/participant and one-parent relation.
const relations=(sql:RepositorySql|SqlClient)=>sql`WITH actors AS (
  SELECT id AS card_id,created_session_id AS session_id FROM cards WHERE created_session_id IS NOT NULL
  UNION SELECT target_id,actor_session_id FROM folder_operations WHERE target_kind='card'
    AND operation_type IN ('create_card','execute_card','add_card_comment') AND actor_session_id IS NOT NULL
), links AS (
  SELECT card_id,session_id FROM actors
  UNION SELECT child.id,a.session_id FROM cards child JOIN cards parent
    ON parent.assignee_session_id=child.created_session_id AND parent.id<>child.id
    JOIN actors a ON a.card_id=parent.id
)`;
export async function readCardBoardSessions(sql:RepositorySql|SqlClient,cardId:string):Promise<Set<string>>{
  const rows=await sql<{session_id:string;session_type:string|null;metadata:unknown}[]>`${relations(sql)}
    SELECT s.session_id,s.session_type,s.metadata FROM sessions s
    WHERE s.session_id IN (SELECT session_id FROM links WHERE card_id=${cardId})`;
  return new Set(rows.filter(r=>r.session_type!=="llm"&&readPersistentEnabled(r.metadata)).map(r=>r.session_id));
}
export async function readBoardCards(sql:RepositorySql,sessionId:string):Promise<BoardCard[]>{
  return sql<BoardCard[]>`${relations(sql)} SELECT c.* FROM cards c
    WHERE c.id IN (SELECT card_id FROM links WHERE session_id=${sessionId})`;
}
