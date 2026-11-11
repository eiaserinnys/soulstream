import type { CardDecisionEvidence } from './card_decision_facts.js';
import type { ServerEvidenceStage } from './card_server_command.js';

export const CARD_REMAINING_EVIDENCE_STAGES={
 BULK_SET_STATUS:['ownerState','claim'],MERGE_SOURCE:['pending'],UPDATE_UNSTARTED:['pending'],SAVE_EXECUTION_SETTINGS:['pending'],
 PATCH_CARD_CONTROL:[],REGISTER_REPLACEMENT:[],
} as const;
/** The service and frozen-row predictor share presence and relationship derivation. */
export function remainingCardEvidence(input:{loaded:readonly ServerEvidenceStage[];pendingRows?:readonly unknown[];
 owner?:{status?:string|null}|null;claimCandidates?:readonly {session_id:string}[];actorSessionId?:string|null;
 previousOwnerMatch?:boolean}):CardDecisionEvidence {
 const result:CardDecisionEvidence={loaded:input.loaded,previousOwnerMatch:input.previousOwnerMatch};
 if(input.loaded.includes('pending'))result.pending=!!input.pendingRows?.length;
 if(input.loaded.includes('ownerState'))result.ownerState=!input.owner?'missing':
  ['running','initializing'].includes(input.owner.status??'')?input.owner.status!:'idle';
 if(input.loaded.includes('claim'))result.claim=!!input.actorSessionId&&!!input.claimCandidates?.some(row=>row.session_id===input.actorSessionId);
 return result;
}
