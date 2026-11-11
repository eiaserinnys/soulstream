import { serverCardEvidence, type ServerEvidenceRows } from '../src/cards/state/card_server_evidence.js';
import { humanCardEvidence } from '../src/cards/state/card_human_evidence.js';
import { cardCommandEntryFailure } from '../src/cards/state/card_command_entrance.js';
import { rowToStateValue } from '../src/cards/state/card_state_value.js';
import type { CardDecision } from '../src/cards/state/card_decision.js';
import { generateKeyBetween } from '@soulstream/fractional-position';
import { assigneeToFields } from '../src/cards/control_plane/card_models.js';
import { questionCardNow, checkCardReviewAsk, reviewCardNowFromCheckedAsk, makeCardNow, openCardItemFix } from '../src/cards/card_item_rules.js';
import { verificationWaitNow } from '../src/cards/card_verification_wait.js';
import { formatLimitResumeClock } from '../src/cards/card_limit_auto_resume.js';
import { mergedCloseNow } from '../src/cards/card_maintenance_tx.js';
import { decideCardTransition } from '../src/cards/state/card_decision.js';
import { decodeCardDecision } from '../src/cards/state/card_decision_decoder.js';
import { formatCardDecisionRejection } from '../src/cards/state/card_decision_errors.js';
import type { CardCommand } from '../src/cards/state/card_decision_facts.js';
import type { DecisionObservation } from './card-decision-observation.js';
const METHODS:Record<string,CardCommand['type']>={createCardTx:'CREATE',addCommentTx:'ADD_COMMENT',createCard:'CREATE',setCardStatus:'SET_STATUS',requestCardReview:'REQUEST_REVIEW',resumeBlockedCardOnHumanInput:'HUMAN_INPUT',askQuestion:'ASK_QUESTION',answerQuestion:'ANSWER_QUESTION',withdrawQuestion:'WITHDRAW_QUESTION',addComment:'ADD_COMMENT',startCardWork:'START_WORK',recordExecution:'CONFIRM_EXECUTION',recordDispatch:'DISPATCH',blockCardForLimit:'BLOCK_FOR_LIMIT',resumeLimitedCard:'RESUME_SHORT_LIMIT',resumeDispatchedCard:'RESUME_LONG_LIMIT',resumeVerificationCard:'RESUME_VERIFICATION',noteMissingAssignee:'NOTE_MISSING',bulkSetCardStatus:'BULK_SET_STATUS',mergeCards:'MERGE_SOURCE',patchCard:'PATCH_CARD_CONTROL',updateUnstartedCard:'UPDATE_UNSTARTED',saveExecutionSettings:'SAVE_EXECUTION_SETTINGS'};
/** Reconstruct SQL boundary results from their recorded rows. This adapter never
 * reads observed after or result to select an outcome or any write. */
export function predictObservation(r:DecisionObservation) {
 const row=r.before as any, c:{type:CardCommand['type'];[key:string]:any}={...r.command,type:METHODS[r.method]!},actor=r.actor;
 if(c.type==='ADD_COMMENT')c.entrance=r.method==='addCommentTx'?'followup':'direct';
 const reads=r.evidence.decisionReads as any;
 const session=(id:unknown)=>reads.sessions.find((s:any)=>s.session_id===id);
 const worker=session(actor.sessionId);
 if(c.type==='CREATE'&&actor.kind==='agent'&&actor.sessionId&&c.assignee===undefined)c.assignee={kind:'agent',agentId:worker.agent_id};
 const evidence={
  ...humanCardEvidence(r.evidence.claimableSessions as {session_id:string}[],actor.sessionId,reads.userInputAfterLastReply),
  ...serverCardEvidence({rows:reads as ServerEvidenceRows,card:row??{},command:c,actorSessionId:actor.sessionId,checkedAt:r.checkedAt,
   requests:r.evidence.executionRequests as {state:string}[],dispatches:r.evidence.dispatches as any[],
   claimCandidates:r.evidence.claimableSessions as {session_id:string}[],resumeAt:r.evidence.limitAutoResumeAt?new Date(String(r.evidence.limitAutoResumeAt)):null}),
 };
 const entryFailure=cardCommandEntryFailure(c.type,{hasMode:Boolean(c.mode),requestedSpoken:c.kind==='spoken'},actor);
 const checkedAsk=c.type==='REQUEST_REVIEW'?checkCardReviewAsk(c.ask):undefined;
 const result:CardDecision=entryFailure?{kind:'reject',next:rowToStateValue(row,r.beforeQuestions),actions:[],failure:entryFailure}:
  decideCardTransition(row,r.beforeQuestions,evidence,c as CardCommand,actor,r.checkedAt);
 const at=new Date(r.checkedAt+1), stamp=at.toISOString();
 const control:Record<string,unknown>={};
 if(c.type==='PATCH_CARD_CONTROL'){
 for(const [input,key] of Object.entries({title:'title',brief:'brief',archived:'archived',nodeId:'node_id',modelPreset:'model_preset',color:'color'}))if(Object.hasOwn(c,input))control[key]=c[input];
 if(Object.hasOwn(c,'assignee'))Object.assign(control,assigneeToFields(c.assignee));
 }
 if(c.type==='UPDATE_UNSTARTED'){
 for(const key of ['title','brief','request'])if(Object.hasOwn(c,key))control[key]=c[key];
 if(c.agentId!==undefined)Object.assign(control,assigneeToFields({kind:'agent',agentId:c.agentId}));
 }
 if(c.type==='SAVE_EXECUTION_SETTINGS')Object.assign(control,{node_id:c.nodeId,model_preset:c.modelPreset},assigneeToFields(c.agentId?{kind:'agent',agentId:c.agentId}:null));
 const values:any={card:row??{},command:c,actor,now:at,eventId:actor.sessionId?1:null,values:{
 'command.control':control,'command.assignment':assigneeToFields(c.assignee??null),
 'evidence.resumeAt':evidence.resumeAt,
 },lazy:{
 'queue.new':()=>generateKeyBetween(reads.cards.filter((card:any)=>card.status==='queued'&&!card.archived&&card.id!==row?.id).sort((a:any,b:any)=>a.queue_position_key<b.queue_position_key?-1:a.queue_position_key>b.queue_position_key?1:a.id.localeCompare(b.id)).at(-1)?.queue_position_key??null,null),
 'formatted.question':()=>questionCardNow(row.now??null,c.text??'',stamp,actor.sessionId),
 'formatted.review':()=>reviewCardNowFromCheckedAsk(row.now??null,checkedAsk,stamp,actor.sessionId),
 'formatted.verification':()=>verificationWaitNow(c.waitingFor.trim(),new Date(c.wakeAt),at,actor.sessionId),
 'formatted.limitDetail':()=>evidence.resumeAt?`사용량 한도, ${formatLimitResumeClock(new Date(String(evidence.resumeAt)))} 자동 재개`:'세션 사용량 한도',
 'formatted.limit':()=>evidence.resumeAt?makeCardNow({text:`사용량 한도로 멈춤, ${formatLimitResumeClock(new Date(String(evidence.resumeAt)))}에 저절로 이어집니다`,turn:'outside'},stamp,null):null,
 'formatted.limitResume':()=>makeCardNow({text:'담당이 이어서 진행합니다',turn:'agent'},stamp,null),
 'formatted.verificationResume':()=>makeCardNow({text:'담당이 기다리던 것을 확인합니다',turn:'agent'},stamp,c.sessionId??null),
 'formatted.replacement':()=>makeCardNow({text:'담당이 바뀌어 자동 재개 예약을 해제했습니다',turn:'agent'},stamp,actor.sessionId),
 'formatted.merge':()=>mergedCloseNow(reads.cards.find((card:any)=>card.id===c.targetCardId),stamp,actor.sessionId),
 'formatted.items':()=>openCardItemFix(row.items??[],c.itemId),
 }};
 const writes=decodeCardDecision(result,values);
 const defaults=Object.fromEntries(['blocked_kind','blocked_detail','assignee_kind','assignee_session_id','assignee_agent_id','assignee_user_id','limit_resume_session_id','limit_resume_at','wake_at','waiting_for','completed_kind','completed_session_id','completed_user_id','completed_event_id','completed_at','queue_position_key','now'].map(k=>[k,null]));
 let after:Record<string,any>|null=row?structuredClone(row):null;
 let questions=structuredClone(r.beforeQuestions),updates=0,statusTimeChanged=false;
 if(result.kind==='apply'){
 if(c.type==='CREATE')after={...defaults,id:'predicted-card',version:0,archived:false,status_changed_at:stamp};
 for(const write of writes){
 if(write.kind==='card'){
  if(write.fields.status!==undefined&&after!.status!==undefined&&write.fields.status!==after!.status){statusTimeChanged=true;after!.status_changed_at=stamp;}
 Object.assign(after!,JSON.parse(JSON.stringify(write.fields)));updates++;after!.version=Number(after!.version)+1;
 }else if(write.kind==='questionInsert')questions.push({id:'predicted-question',...write.fields,answer:null,answered_at:null,answered_by:null,withdrawn_at:null,withdrawn_by_session_id:null,withdrawal_reason:null});
 else if(write.kind==='closeQuestions')questions=questions.map(q=>q.answer===null&&q.withdrawn_at===null?{...q,...write.fields}:q);
 else questions=questions.map(q=>q.id===c.questionId?{...q,...write.fields}:q);
 }
 }
 const failure=result.kind==='reject'?formatCardDecisionRejection(c.type,row.id,result.failure,{label:`#${row.number}`,status:row.status,length:[...String(c.body??c.waitingFor??'')].length}):null;
 const kind=updates>0||JSON.stringify(questions)!==JSON.stringify(r.beforeQuestions)?'success':'noop';
 return {decision:result,writes,observation:{...r,after,afterQuestions:JSON.parse(JSON.stringify(questions)),versionDelta:updates,statusTimeChanged:!!row&&statusTimeChanged,
 result:failure??{kind,value:null,statusCode:null,code:null,message:null}} as DecisionObservation};
}
