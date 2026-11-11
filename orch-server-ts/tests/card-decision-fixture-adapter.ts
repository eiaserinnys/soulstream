import { generateKeyBetween } from '@soulstream/fractional-position';
import { isUsageLimitTermination } from '../src/session/session_limit_termination.js';
import { assigneeToFields } from '../src/cards/control_plane/card_models.js';
import { questionCardNow, reviewCardNow, makeCardNow, openCardItemFix } from '../src/cards/card_item_rules.js';
import { verificationWaitNow } from '../src/cards/card_verification_wait.js';
import { formatLimitResumeClock } from '../src/cards/card_limit_auto_resume.js';
import { mergedCloseNow } from '../src/cards/card_maintenance_tx.js';
import { decideCardTransition } from '../src/cards/state/card_decision.js';
import { decodeCardDecision } from '../src/cards/state/card_decision_decoder.js';
import { formatCardDecisionFailure } from '../src/cards/state/card_decision_errors.js';
import type { CardCommand } from '../src/cards/state/card_decision_facts.js';
import type { DecisionObservation } from './card-decision-observation.js';
const METHODS:Record<string,CardCommand['type']>={createCard:'CREATE',setCardStatus:'SET_STATUS',requestCardReview:'REQUEST_REVIEW',resumeBlockedCardOnHumanInput:'HUMAN_INPUT',askQuestion:'ASK_QUESTION',answerQuestion:'ANSWER_QUESTION',withdrawQuestion:'WITHDRAW_QUESTION',addComment:'ADD_COMMENT',startCardWork:'START_WORK',recordExecution:'CONFIRM_EXECUTION',recordDispatch:'DISPATCH',blockCardForLimit:'BLOCK_FOR_LIMIT',resumeLimitedCard:'RESUME_SHORT_LIMIT',resumeDispatchedCard:'RESUME_LONG_LIMIT',resumeVerificationCard:'RESUME_VERIFICATION',noteMissingAssignee:'NOTE_MISSING',bulkSetCardStatus:'BULK_SET_STATUS',mergeCards:'MERGE_SOURCE',patchCard:'PATCH_CARD_CONTROL',updateUnstartedCard:'UPDATE_UNSTARTED',saveExecutionSettings:'SAVE_EXECUTION_SETTINGS'};
/** Reconstruct SQL boundary results from their recorded rows. This adapter never
 * reads observed after or result to select an outcome or any write. */
export function predictObservation(r:DecisionObservation) {
 const row=r.before as any, c={...r.command,type:METHODS[r.method]!} as CardCommand,actor=r.actor;
 const reads=r.evidence.decisionReads as any;
 const session=(id:unknown)=>reads.sessions.find((s:any)=>s.session_id===id);
 const worker=session(actor.sessionId);
 if(c.type==='CREATE'&&actor.kind==='agent'&&actor.sessionId&&c.assignee===undefined)c.assignee={kind:'agent',agentId:worker.agent_id};
 const requests=r.evidence.executionRequests as any[];
 const dispatches=r.evidence.dispatches as any[];
 const active=dispatches.find(d=>d.session_id===actor.sessionId&&['admitted','launching'].includes(d.state));
 const registrations=reads.registrations as any[];
 const registered=(p:any)=>p.effect_application?.applied===true&&p.effect_application?.canonical_execution_registration?.registration_id===c.execution?.registrationId&&p.effect_application?.canonical_execution_registration?.execution_command_id===c.execution?.executionCommandId;
 let admissionReceipt=false;
 if(active){
 if(active.input.deliveryId){const d=reads.deliveries.find((d:any)=>d.delivery_id===active.input.deliveryId&&d.target_session_id===actor.sessionId&&d.state==='consumed');
 const eventId=d&&/^event:\d+$/.test(d.target_receipt_id)?Number(d.target_receipt_id.slice(6)):-1;
 const receipt=registrations.filter(p=>p.session_id===actor.sessionId&&p.event_id<=eventId&&p.effect_application?.applied===true&&p.effect_application.canonical_execution_registration).at(-1);
 admissionReceipt=!!receipt&&registered(receipt);
 }else admissionReceipt=registrations.some(p=>p.session_id===actor.sessionId&&registered(p)&&new Date(p.created_at)>=new Date(active.created_at));
 }
 const run=reads.admissionRun;
 const enabled=reads.orchestrationPolicy?.value.enabled===true;
 const limit=reads.dispatchPolicy?.value.nodeConcurrency?.[c.nodeId]??reads.dispatchPolicy?.value.nodeConcurrency?.default;
 const folder=reads.folders.find((f:any)=>f.id===row?.folder_id);
 const owner=session(row?.assignee_session_id);
 const eligible=row&&!row.archived&&!folder?.archived&&(
 row.assignee_kind==='agent'&&row.assignee_agent_id===c.admission?.workerInput.agentId&&(row.node_id??'eiaserinnys')===c.nodeId&&row.model_preset===(c.admission?.workerInput.configuredModelPreset??null)||
 row.assignee_kind==='session'&&owner?.session_id===c.sessionId&&owner.node_id===c.nodeId&&owner.agent_id===c.admission?.workerInput.agentId&&owner.model_preset===(c.admission?.workerInput.modelPreset??null));
 const occupied=reads.capacitySessions;
 const admission=!c.admission?'ok':!run||run.state!=='decided'||run.lease_token!==c.admission.leaseToken||new Date(run.lease_expires_at).getTime()<=r.checkedAt||run.policy_version!==Number(reads.orchestrationPolicy?.version)||!run.decision.decisions.some((d:any)=>d.cardId===row.id&&d.cardVersion===row.version&&d.action==='run')?'stale':limit===undefined?'missingCapacity':occupied.filter((s:any)=>s.node_id===c.nodeId).length>=limit&&!occupied.some((s:any)=>s.session_id===c.sessionId&&s.node_id===c.nodeId)?'capacity':!eligible?'ineligible':'ok';
 const activeRun=active&&reads.dispatchRuns.find((run:any)=>run.id===active.run_id);
 const admissionValid=!!active&&active.state==='launching'&&active.launch_accepted&&enabled&&Number(reads.orchestrationPolicy.version)===activeRun?.policy_version&&worker?.node_id===active.node_id&&worker?.agent_id===active.input.agentId&&worker?.model_preset===(active.input.modelPreset??null)&&Number(active.input.admittedCardVersion)===row.version&&(row.assignee_kind==='session'?row.assignee_session_id===actor.sessionId:row.assignee_kind==='agent'&&row.assignee_agent_id===active.input.agentId);
 const evidence={
 claim:(r.evidence.claimableSessions as any[]).some(s=>s.session_id===actor.sessionId),
 execution:!!worker&&worker.execution_registration_id===c.execution?.registrationId&&worker.execution_command_id===c.execution?.executionCommandId&&!['completed','error','interrupted'].includes(worker.status)&&!(worker.metadata??[]).some((m:any)=>m.type==='card_orchestration_decision'),
 admitted:admissionReceipt&&admissionValid,admissionReceipt,admissionValid,
 sessionCardId:session(c.sessionId)?.card_id,statusChanged:reads.executionStatusChanged,
 pending:requests.some(q=>q.state==='pending'),policyEnabled:enabled,admission,
 termination:!!owner&&isUsageLimitTermination(owner)&&owner.termination_event_id===c.terminationEventId,
 resumeAt:r.evidence.limitAutoResumeAt,userInput:reads.userInputAfterLastReply,
 ownerState:!owner?'missing':['running','initializing'].includes(owner.status)?owner.status:'idle',
 };
 const result=decideCardTransition(row,r.beforeQuestions,evidence,c,actor,r.checkedAt);
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
 const values:any={card:row??{},command:c,actor,now:at,eventId:actor.sessionId?1:null,queuePosition:generateKeyBetween(reads.cards.filter((card:any)=>card.status==='queued'&&!card.archived&&card.id!==row?.id).sort((a:any,b:any)=>a.queue_position_key<b.queue_position_key?-1:a.queue_position_key>b.queue_position_key?1:a.id.localeCompare(b.id)).at(-1)?.queue_position_key??null,null),values:{
 'command.control':control,'command.assignment':assigneeToFields(c.assignee??null),
 'evidence.resumeAt':evidence.resumeAt,
 'formatted.question':row?questionCardNow(row.now??null,c.text??'',stamp,actor.sessionId):null,
 'formatted.review':row?reviewCardNow(row.now??null,c.ask,stamp,actor.sessionId):null,
 'formatted.verification':c.waitingFor!==undefined&&c.wakeAt?verificationWaitNow(c.waitingFor.trim(),new Date(c.wakeAt),at,actor.sessionId):null,
 'formatted.limitDetail':evidence.resumeAt?`사용량 한도, ${formatLimitResumeClock(new Date(String(evidence.resumeAt)))} 자동 재개`:'세션 사용량 한도',
 'formatted.limit':evidence.resumeAt?makeCardNow({text:`사용량 한도로 멈춤, ${formatLimitResumeClock(new Date(String(evidence.resumeAt)))}에 저절로 이어집니다`,turn:'outside'},stamp,null):null,
 'formatted.limitResume':makeCardNow({text:'담당이 이어서 진행합니다',turn:'agent'},stamp,null),
 'formatted.verificationResume':makeCardNow({text:'담당이 기다리던 것을 확인합니다',turn:'agent'},stamp,c.sessionId??null),
 'formatted.replacement':makeCardNow({text:'담당이 바뀌어 자동 재개 예약을 해제했습니다',turn:'agent'},stamp,actor.sessionId),
 'formatted.merge':c.targetCardId?mergedCloseNow(reads.cards.find((card:any)=>card.id===c.targetCardId),stamp,actor.sessionId):null,
 'formatted.items':c.itemId!==undefined?openCardItemFix(row.items??[],c.itemId):undefined,
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
 const failure=result.kind==='reject'?formatCardDecisionFailure(result.failure,{label:`#${row.number}`,status:row.status,length:[...String(c.body??c.waitingFor??'')].length}):null;
 const kind=result.kind==='reject'?(c.type==='BULK_SET_STATUS'?'noop':'error'):updates>0||JSON.stringify(questions)!==JSON.stringify(r.beforeQuestions)?'success':'noop';
 return {decision:result,writes,observation:{...r,after,afterQuestions:JSON.parse(JSON.stringify(questions)),versionDelta:updates,statusTimeChanged:!!row&&statusTimeChanged,
 result:{kind,value:null,statusCode:failure?.statusCode??null,code:failure?.code??null,message:failure?.message??null}} as DecisionObservation};
}
