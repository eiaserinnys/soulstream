import { randomUUID } from "node:crypto";
import type { SqlClient } from "../control_plane_types.js";
import type { RepositorySql } from "../../cards/control_plane/card_types.js";
import { assertSingleCardAssignee } from "../../cards/card_assignee.js";
import { appendFolderOperation } from "../../folders/folder_operation_store.js";

/** Called inside the same transaction as the new session registration. */
export async function applySessionCardReplacement(sql:SqlClient,sessionId:string):Promise<void> {
  const row=(await sql<Array<{card_id:string;operation_id:string;actor_session_id:string;actor_user_id:string|null;
    folder_id:string;payload_json:{previous_assignee:{session_id:string};target:{nodeId:string;modelPreset:string|null}}}>>`
    SELECT r.card_id,op.id AS operation_id,op.actor_session_id,op.actor_user_id,op.folder_id,op.payload_json
    FROM card_execution_requests r JOIN folder_operations op ON r.idempotency_key='dispatch-work-replace:'||op.id
    WHERE r.session_id=${sessionId} AND r.state='pending' AND r.mode='create'
      AND op.target_kind='card' AND op.target_id=r.card_id AND op.operation_type='execute_card'
      AND op.actor_kind='agent' AND op.actor_session_id IS NOT NULL AND op.payload_json->>'dispatch_kind'='replace_assignee'
      AND op.payload_json->>'new_session_id'=r.session_id LIMIT 1`)[0];
  if(!row)return;
  const card=(await sql<Array<{assignee_kind:string|null;assignee_session_id:string|null;archived:boolean;folder_id:string}>>`
    SELECT assignee_kind,assignee_session_id,archived,folder_id FROM cards WHERE id=${row.card_id} FOR UPDATE`)[0];
  const oldId=row.payload_json.previous_assignee.session_id;
  if(!card || card.assignee_kind!=="session" || card.assignee_session_id!==oldId)
    throw Object.assign(new Error("예약 이후 카드 담당이 바뀌었습니다. 현재 담당을 확인하세요."),{statusCode:409});
  const repositorySql=sql as unknown as RepositorySql;
  if(!card.archived) await assertSingleCardAssignee(repositorySql,sessionId,row.card_id);
  await sql`UPDATE cards SET assignee_kind='session',assignee_session_id=${sessionId},assignee_agent_id=NULL,
    node_id=${row.payload_json.target.nodeId},model_preset=${row.payload_json.target.modelPreset},
    version=version+1,updated_at=NOW(),updated_session_id=${row.actor_session_id},updated_event_id=NULL WHERE id=${row.card_id}`;
  await sql`UPDATE sessions SET caller_session_id=${sessionId} WHERE card_id=${row.card_id}
    AND caller_session_id=${oldId} AND session_id<>${sessionId}`;
  await appendFolderOperation(repositorySql,{id:randomUUID(),folderId:card.folder_id,targetKind:"card",targetId:row.card_id,
    operationType:"update_card",actorKind:"agent",actorSessionId:row.actor_session_id,actorUserId:row.actor_user_id,actorEventId:null,
    payload:{assignee:{kind:"session",sessionId},replacement:{from_session_id:oldId,to_session_id:sessionId,dispatch_operation_id:row.operation_id}}});
}
