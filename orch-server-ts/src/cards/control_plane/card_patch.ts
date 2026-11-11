import { assertSingleCardAssignee } from "../card_assignee.js";
import { makeCardNow } from "../card_item_rules.js";
import type { CardRow, FolderActorParams, RepositorySql } from "./card_types.js";

/** All runtime writes to card status, assignment and archive normalize reservations here. */
export async function patchCardTx(sql:RepositorySql,card:CardRow,fields:Record<string,unknown>,actor:FolderActorParams,eventId:number | null) {
  const next={...card,...fields};
  if (typeof next.assignee_session_id === "string" && (Object.hasOwn(fields,"assignee_session_id") || fields.archived === false) && !next.archived)
    await assertSingleCardAssignee(sql,next.assignee_session_id,card.id);
  const changedAssignee=next.assignee_kind!==card.assignee_kind || next.assignee_session_id!==card.assignee_session_id;
  const clearLimit=next.status!=="blocked" || next.blocked_kind!=="limit" || changedAssignee || next.archived;
  const writes:Record<string,unknown>={...fields,
    ...(fields.status!==undefined && fields.status!=="awaiting_verification" ? {wake_at:null,waiting_for:null} : {}),
    ...(clearLimit ? {limit_resume_session_id:null,limit_resume_at:null} : {}),
  };
  if (changedAssignee && card.limit_resume_session_id && fields.now===undefined) {
    writes.now=sql.json(makeCardNow({text:"담당이 바뀌어 자동 재개 예약을 해제했습니다",turn:"agent"},new Date().toISOString(),actor.actorSessionId));
  }
  await sql`UPDATE cards SET ${sql(writes)},
    number=CASE WHEN ${writes.archived===false} THEN COALESCE(number,nextval('cards_number_seq')) ELSE number END,
    status_changed_at=CASE WHEN ${writes.status!==undefined && writes.status!==card.status} THEN NOW() ELSE status_changed_at END,
    version=version+1,updated_at=NOW(),updated_session_id=${actor.actorSessionId},updated_event_id=${eventId} WHERE id=${card.id}`;
}
