import { assertSingleCardAssignee } from "../card_assignee.js";
import type { CardRow, FolderActorParams, RepositorySql } from "./card_types.js";

/** Apply final column writes. Assignment uniqueness remains a SQL fence. */
export async function patchCardTx(sql:RepositorySql,card:CardRow,fields:Record<string,unknown>,actor:FolderActorParams,eventId:number | null) {
  const next={...card,...fields};
  if (typeof next.assignee_session_id === "string" && (Object.hasOwn(fields,"assignee_session_id") || fields.archived === false) && !next.archived)
    await assertSingleCardAssignee(sql,next.assignee_session_id,card.id);
  const writes={...fields};
  await sql`UPDATE cards SET ${sql(writes)},
    number=CASE WHEN ${writes.archived===false} THEN COALESCE(number,nextval('cards_number_seq')) ELSE number END,
    status_changed_at=CASE WHEN ${writes.status!==undefined && writes.status!==card.status} THEN NOW() ELSE status_changed_at END,
    version=version+1,updated_at=NOW(),updated_session_id=${actor.actorSessionId},updated_event_id=${eventId} WHERE id=${card.id}`;
}
