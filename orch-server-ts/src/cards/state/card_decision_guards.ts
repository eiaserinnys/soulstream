import { and, or, not, stateIn } from 'xstate';
import type { ServerEvidenceStage } from './card_server_command.js';
import { CARD_FACT_VALUES, type DecisionEvent, type CardDecisionCommand } from './card_decision_facts.js';
export const decisionGuards:Record<string,any>={};
export const rejections:Record<string,{guard:string;failure?:string;stage?:ServerEvidenceStage}[]>=Object.fromEntries(Object.keys(CARD_FACT_VALUES).map(c=>[c,[]]));
export const inside=(id:string)=>stateIn(`#${id}`);
export const any=(...ids:string[])=>or(ids.map(inside));
export const fact=(key:string,value:string|boolean=true):any=>({event}:{event:DecisionEvent})=>(event.facts as Record<string,unknown>)[key]===value;
const actor=(...actors:string[]):any=>({event}:{event:DecisionEvent})=>actors.includes(event.actor);
const owner=actor('owner','ownerAuthor'),agent=actor('owner','ownerAuthor','author','otherAgent','anonymousAgent'),session=actor('owner','ownerAuthor','author','otherAgent');
const effectiveOwner=or([owner,and([session,fact('claim')])]);
const rest=or(['todo','queued','hold','cancelled'].map(t=>fact('target',t)));
const resumable=and([any('s_question','s_noReport','s_other','s_verification'),inside('a_session'),inside('arch_active')]);
function reject(command:CardDecisionCommand,name:string,failure:string,guard:any){
 const key=`reject.${command}.${name}`;decisionGuards[key]=guard;rejections[command]!.push({guard:key,failure});
}
function need(command:CardDecisionCommand,stage:ServerEvidenceStage,...conditions:any[]){
 const key=`needs.${command}.${stage}`;decisionGuards[key]=and([fact('evidenceMissing',stage),...conditions]);
 rejections[command]!.push({guard:key,stage});
}
function statusRights(command:CardDecisionCommand){reject(command,'statusOwner','statusOwner',and([agent,not(effectiveOwner),not(and([session,not(any('a_human','a_session')),rest])),not(and([session,inside('s_review'),fact('target','done'),fact('supervises')]))]));}
statusRights('SET_STATUS');
reject('SET_STATUS','verificationOwner','verificationOwner',and([fact('target','verification'),not(or([inside('a_session'),and([session,fact('claim')])]))]));
for(const value of ['missing','empty','tooLong','invalid','past','tooLate'])reject('SET_STATUS',`verification_${value}`,`verification_${value}`,and([fact('target','verification'),fact('wait',value)]));
reject('REQUEST_REVIEW','reviewAsk','reviewAsk',and([fact('hasItems'),not(fact('hasAsk'))]));
reject('REQUEST_REVIEW','statusOwner','statusOwner',and([agent,not(effectiveOwner)]));
reject('ASK_QUESTION','otherAssignee','otherAssignee',and([agent,inside('a_session'),not(owner)]));
for(const value of ['missing','answered','withdrawn'])reject('ASK_QUESTION',`edit_${value}`,`edit_${value}`,and([fact('editing'),fact('targetQuestion',value)]));
reject('ANSWER_QUESTION','withdrawnAnswer','withdrawnAnswer',fact('question','withdrawn'));
reject('ANSWER_QUESTION','openQuestion','openQuestion',not(fact('question','open')));
reject('WITHDRAW_QUESTION','ownerOrAuthor','withdrawOwner',not(actor('owner','ownerAuthor','author')));
for(const value of ['missing','answered','withdrawn'])reject('WITHDRAW_QUESTION',value,`withdraw_${value}`,fact('question',value));
reject('ADD_COMMENT','otherAssignee','otherAssignee',and([fact('entrance','direct'),not(fact('reply')),agent,inside('a_session'),not(owner)]));
reject('ADD_COMMENT','commentMode','commentMode',and([agent,fact('hasItems'),not(fact('hasMode'))]));
reject('ADD_COMMENT','questionMissing','questionMissing',and([fact('hasQuestion'),fact('targetQuestion','missing')]));
reject('ADD_COMMENT','questionWithdrawn','questionWithdrawn',and([fact('hasQuestion'),fact('targetQuestion','withdrawn')]));
reject('ADD_COMMENT','questionItem','questionItem',and([fact('hasQuestion'),fact('hasItem')]));
reject('ADD_COMMENT','questionSpoken','questionSpoken',and([fact('hasQuestion'),fact('requestedSpoken')]));
reject('ADD_COMMENT','replyOwner','replyOwner',and([fact('reply'),not(or([effectiveOwner,and([fact('hasQuestion'),not(inside('a_session')),actor('author')])]))]));
reject('ADD_COMMENT','replyLength','replyLength',and([fact('reply'),or([fact('hasItems'),fact('hasQuestion')]),fact('replyLength','tooLong')]));
reject('ADD_COMMENT','userInput','replyUserInput',and([fact('reply'),or([fact('hasItems'),fact('hasQuestion')]),not(fact('userInput'))]));
reject('ADD_COMMENT','itemMissing','itemMissing',and([fact('hasItem'),not(fact('itemExists'))]));
need('START_WORK','execution');reject('START_WORK','execution','workExecution',not(fact('execution')));
need('START_WORK','workAdmission');
reject('START_WORK','admission','workAdmission',and([fact('admissionReceipt'),not(fact('admissionValid'))]));
need('START_WORK','claim',not(fact('admitted')));
reject('START_WORK','owner','workOwner',not(or([effectiveOwner,fact('admitted')])));
need('CONFIRM_EXECUTION','executionSession');
reject('CONFIRM_EXECUTION','executionMatches','executionMatches',not(fact('sessionMatch')));
need('CONFIRM_EXECUTION','executionStatus');
reject('DISPATCH','queued','queued',not(any('s_queued','s_missing')));
reject('BLOCK_FOR_LIMIT','currentRunningOwner','limitRunning',not(and([inside('s_running'),inside('arch_active'),inside('a_session'),fact('sessionMatch')])));
need('BLOCK_FOR_LIMIT','termination');
reject('BLOCK_FOR_LIMIT','currentTermination','limitTermination',not(fact('termination')));
need('BLOCK_FOR_LIMIT','limitReset');
reject('RESUME_SHORT_LIMIT','sameDueReservation','shortReservation',not(and([inside('s_limit'),inside('arch_active'),inside('a_session'),fact('sessionMatch'),inside('r_limit'),fact('due'),fact('resumeTimeMatch')])));
reject('RESUME_LONG_LIMIT','sameLongReservation','longReservation',not(and([inside('s_limit'),inside('arch_active'),fact('sessionMatch'),inside('r_longLimit')])));
reject('RESUME_VERIFICATION','sameReservation','verificationReservation',not(and([inside('s_verification'),inside('a_session'),fact('sessionMatch'),inside('r_verify'),fact('verificationTimeMatch')])));
for(const c of ['DISPATCH','RESUME_LONG_LIMIT','RESUME_SHORT_LIMIT'] as const){need(c,'pending');reject(c,'pending','pending',fact('pending'));}
for(const c of ['DISPATCH','RESUME_LONG_LIMIT'] as const){
 need(c,'policy');
 reject(c,'policyDisabled','policyDisabled',and([not(fact('policyEnabled')),fact('hasAdmission')]));
 reject(c,'admissionRequired','admissionRequired',and([fact('policyEnabled'),not(fact('hasAdmission'))]));
 need(c,'admission',fact('policyEnabled'),fact('hasAdmission'));
 for(const a of ['lockedPolicyDisabled','stale','capacity','missingCapacity','ineligible'])reject(c,a,`admission_${a}`,and([fact('policyEnabled'),fact('hasAdmission'),fact('admission',a)]));
}
reject('BULK_SET_STATUS','human','bulkHuman',inside('a_human'));
reject('BULK_SET_STATUS','cardRunning','bulkRunning',and([fact('hasOwnerSession'),inside('s_running')]));
need('BULK_SET_STATUS','ownerState');
reject('BULK_SET_STATUS','missing','bulkMissing',and([fact('hasOwnerSession'),fact('ownerState','missing')]));
reject('BULK_SET_STATUS','ownerRunning','bulkRunning',and([fact('hasOwnerSession'),or([fact('ownerState','running'),fact('ownerState','initializing')])]));
reject('BULK_SET_STATUS','rest','bulkRest',and([fact('hasOwnerSession'),or([fact('target','todo'),fact('target','queued')])]));
need('BULK_SET_STATUS','claim',not(fact('hasOwnerSession')));
for(const c of ['MERGE_SOURCE','UPDATE_UNSTARTED'] as const){
 reject(c,'archived','unstarted_archived',inside('arch_archived'));
 reject(c,'human','unstarted_human',inside('a_human'));
 reject(c,'connected','unstarted_session',fact('hasOwnerSession'));
 reject(c,'status','unstarted_status',not(any('s_todo','s_queued','s_missing','s_hold')));
 need(c,'pending');
 reject(c,'pending','maintenancePending',fact('pending'));
}
need('SAVE_EXECUTION_SETTINGS','pending');
reject('SAVE_EXECUTION_SETTINGS','pending','pending',fact('pending'));reject('SAVE_EXECUTION_SETTINGS','owner','settingsOwner',fact('hasOwnerSession'));
reject('REGISTER_REPLACEMENT','owner','replacementOwner',not(fact('previousOwnerMatch')));
for(const c of Object.keys(CARD_FACT_VALUES))decisionGuards[`permitted.${c}`]=not(or(rejections[c]!.map(r=>r.guard)));
decisionGuards.humanResumable=resumable;
decisionGuards.commentResumable=and([resumable,not(fact('reply')),not(fact('hasQuestion'))]);
decisionGuards.lastQuestion=and([inside('s_question'),not(fact('otherOpen'))]);
decisionGuards.claiming=and([agent,fact('claim')]);
export const permitted=(c:CardDecisionCommand,...conditions:any[])=>and([`permitted.${c}`,...conditions]);
