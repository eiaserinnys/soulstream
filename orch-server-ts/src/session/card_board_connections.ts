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
  // 카드 키를 CTE 안으로 밀어 넣는다. 이 카드와 그 부모 카드의 배우자만 CROSS JOIN LATERAL로 펼치므로
  // actors/links가 카드·folder_operations 전체를 훑지 않는다. 결과 행은 기존 relations와 같다.
  const rows=await sql<{session_id:string;session_type:string|null;metadata:unknown}[]>`SELECT s.session_id,s.session_type,s.metadata FROM sessions s
    WHERE s.session_id IN (
      SELECT created_session_id FROM cards WHERE id=${cardId} AND created_session_id IS NOT NULL
      UNION SELECT actor_session_id FROM folder_operations WHERE target_kind='card' AND target_id=${cardId}
        AND operation_type IN ('create_card','execute_card','add_card_comment') AND actor_session_id IS NOT NULL
      UNION SELECT a.session_id FROM cards child
        JOIN cards parent ON parent.assignee_session_id=child.created_session_id AND parent.id<>child.id
        CROSS JOIN LATERAL (
          SELECT created_session_id AS session_id FROM cards WHERE id=parent.id AND created_session_id IS NOT NULL
          UNION SELECT actor_session_id FROM folder_operations WHERE target_kind='card' AND target_id=parent.id
            AND operation_type IN ('create_card','execute_card','add_card_comment') AND actor_session_id IS NOT NULL) a
        WHERE child.id=${cardId})`;
  return new Set(rows.filter(r=>r.session_type!=="llm"&&readPersistentEnabled(r.metadata)).map(r=>r.session_id));
}
export async function readBoardCards(sql:RepositorySql,sessionId:string):Promise<BoardCard[]>{
  return sql<BoardCard[]>`${relations(sql)} SELECT c.* FROM cards c
    WHERE c.id IN (SELECT card_id FROM links WHERE session_id=${sessionId})`;
}
