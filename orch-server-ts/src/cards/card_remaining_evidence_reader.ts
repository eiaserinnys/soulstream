import type { CardRow, FolderActorParams, RepositorySql } from './control_plane/card_types.js';
import { claimableCardSessions } from './card_assignee.js';
import { decideCardTransition, type CardDecision } from './state/card_decision.js';
import { CARD_REMAINING_EVIDENCE_STAGES, remainingCardEvidence } from './state/card_remaining_evidence.js';
import type { CardCommand } from './state/card_decision_facts.js';
import type { ServerEvidenceStage } from './state/card_server_command.js';

/** IO follows only the next evidence transition; earlier rejections skip later reads. */
export async function readRemainingCardDecision(sql:RepositorySql,card:CardRow,command:CardCommand,
 actor:FolderActorParams):Promise<CardDecision> {
 const loaded:ServerEvidenceStage[]=[];
 const input:Parameters<typeof remainingCardEvidence>[0]={loaded,actorSessionId:actor.actorSessionId};
 const stages=CARD_REMAINING_EVIDENCE_STAGES[command.type as keyof typeof CARD_REMAINING_EVIDENCE_STAGES];
 for(let count=0;count<=stages.length;count++){
  const decision=decideCardTransition(card,[],remainingCardEvidence(input),command,
   {kind:actor.actorKind,sessionId:actor.actorSessionId,userId:actor.actorUserId},Date.now());
  if(decision.kind!=='needsEvidence')return decision;
  switch(decision.stage){
  case 'pending':input.pendingRows=await sql`SELECT id FROM card_execution_requests WHERE card_id=${card.id} AND state='pending' LIMIT 1`;break;
  case 'ownerState':if(card.assignee_session_id!==null)input.owner=(await sql<{status:string|null}[]>`SELECT status FROM sessions WHERE session_id=${card.assignee_session_id}`)[0];break;
  case 'claim':input.claimCandidates=await claimableCardSessions(sql,card.id,actor.actorSessionId);break;
  }
  loaded.push(decision.stage);
 }
 throw new Error('Card evidence stage bound exceeded');
}
