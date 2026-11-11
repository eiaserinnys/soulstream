import { and, or, not, stateIn } from 'xstate';
import { CARD_FACT_VALUES, type DecisionEvent, type CardDecisionCommand } from './card_decision_facts.js';
export const decisionGuards:Record<string,any>={};
export const rejections:Record<string,{guard:string;failure:string}[]>=Object.fromEntries(Object.keys(CARD_FACT_VALUES).map(c=>[c,[]]));
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
function statusRights(command:CardDecisionCommand){reject(command,'statusOwner','statusOwner',and([agent,not(effectiveOwner),not(and([session,not(any('a_human','a_session')),rest]))]));}
statusRights('SET_STATUS');
reject('SET_STATUS','verificationOwner','verificationOwner',and([fact('target','verification'),not(or([inside('a_session'),and([session,fact('claim')])]))]));
for(const value of ['missing','empty','tooLong','invalid','past','tooLate'])reject('SET_STATUS',`verification_${value}`,`verification_${value}`,and([fact('target','verification'),fact('wait',value)]));
reject('REQUEST_REVIEW','reviewAsk','reviewAsk',and([fact('hasItems'),not(fact('hasAsk'))]));
reject('REQUEST_REVIEW','statusOwner','statusOwner',and([agent,not(effectiveOwner)]));
reject('ASK_QUESTION','otherAssignee','otherAssignee',and([agent,inside('a_session'),not(owner)]));
reject('ANSWER_QUESTION','withdrawnAnswer','withdrawnAnswer',fact('question','withdrawn'));
reject('ANSWER_QUESTION','openQuestion','openQuestion',not(fact('question','open')));
reject('WITHDRAW_QUESTION','ownerOrAuthor','withdrawOwner',not(actor('owner','ownerAuthor','author')));
for(const value of ['missing','answered','withdrawn'])reject('WITHDRAW_QUESTION',value,`withdraw_${value}`,fact('question',value));
reject('ADD_COMMENT','otherAssignee','otherAssignee',and([fact('entrance','direct'),not(fact('reply')),agent,inside('a_session'),not(owner)]));
reject('ADD_COMMENT','commentMode','commentMode',and([agent,fact('hasItems'),not(fact('hasMode'))]));
reject('ADD_COMMENT','replyOwner','replyOwner',and([fact('reply'),not(effectiveOwner)]));
reject('ADD_COMMENT','replyLength','replyLength',and([fact('reply'),fact('hasItems'),fact('replyLength','tooLong')]));
reject('ADD_COMMENT','userInput','replyUserInput',and([fact('reply'),fact('hasItems'),not(fact('userInput'))]));
reject('ADD_COMMENT','itemMissing','itemMissing',and([fact('hasItem'),not(fact('itemExists'))]));
reject('START_WORK','actor','workOwner',not(session));reject('START_WORK','execution','workExecution',not(fact('execution')));
reject('START_WORK','admission','workAdmission',and([fact('admissionReceipt'),not(fact('admissionValid'))]));
reject('START_WORK','owner','workOwner',not(or([effectiveOwner,fact('admitted')])));
reject('CONFIRM_EXECUTION','executionMatches','executionMatches',not(fact('sessionMatch')));
reject('DISPATCH','queued','queued',not(any('s_queued','s_missing')));
reject('BLOCK_FOR_LIMIT','currentRunningOwner','limitRunning',not(and([inside('s_running'),inside('arch_active'),inside('a_session'),fact('sessionMatch')])));
reject('BLOCK_FOR_LIMIT','currentTermination','limitTermination',not(fact('termination')));
reject('RESUME_SHORT_LIMIT','sameDueReservation','shortReservation',not(and([inside('s_limit'),inside('arch_active'),inside('a_session'),fact('sessionMatch'),inside('r_limit'),fact('due'),fact('resumeTimeMatch')])));
reject('RESUME_LONG_LIMIT','sameLongReservation','longReservation',not(and([inside('s_limit'),inside('arch_active'),fact('sessionMatch'),inside('r_longLimit')])));
reject('RESUME_VERIFICATION','sameReservation','verificationReservation',not(and([inside('s_verification'),inside('a_session'),fact('sessionMatch'),inside('r_verify'),fact('verificationTimeMatch')])));
for(const c of ['DISPATCH','RESUME_LONG_LIMIT','RESUME_SHORT_LIMIT'] as const)reject(c,'pending','pending',fact('pending'));
for(const c of ['DISPATCH','RESUME_LONG_LIMIT'] as const){
 reject(c,'policyDisabled','policyDisabled',and([not(fact('policyEnabled')),fact('hasAdmission')]));
 reject(c,'admissionRequired','admissionRequired',and([fact('policyEnabled'),not(fact('hasAdmission'))]));
 for(const a of ['stale','capacity','missingCapacity','ineligible'])reject(c,a,`admission_${a}`,and([fact('policyEnabled'),fact('hasAdmission'),fact('admission',a)]));
}
for(const c of ['BULK_SET_STATUS','MERGE_SOURCE','UPDATE_UNSTARTED'] as const)reject(c,'session','maintenanceSession',not(session));
reject('BULK_SET_STATUS','human','bulkHuman',inside('a_human'));
reject('BULK_SET_STATUS','cardRunning','bulkRunning',and([inside('a_session'),inside('s_running')]));
reject('BULK_SET_STATUS','missing','bulkMissing',and([inside('a_session'),fact('ownerState','missing')]));
reject('BULK_SET_STATUS','ownerRunning','bulkRunning',and([inside('a_session'),or([fact('ownerState','running'),fact('ownerState','initializing')])]));
reject('BULK_SET_STATUS','rest','bulkRest',and([inside('a_session'),or([fact('target','todo'),fact('target','queued')])]));
for(const c of ['MERGE_SOURCE','UPDATE_UNSTARTED'] as const){
 reject(c,'archived','unstarted_archived',inside('arch_archived'));
 reject(c,'human','unstarted_human',inside('a_human'));
 reject(c,'connected','unstarted_session',inside('a_session'));
 reject(c,'status','unstarted_status',not(any('s_todo','s_queued','s_missing','s_hold')));
 reject(c,'pending','maintenancePending',fact('pending'));
}
reject('SAVE_EXECUTION_SETTINGS','pending','pending',fact('pending'));reject('SAVE_EXECUTION_SETTINGS','owner','settingsOwner',inside('a_session'));
reject('REGISTER_REPLACEMENT','owner','replacementOwner',not(fact('previousOwnerMatch')));
for(const c of Object.keys(CARD_FACT_VALUES))decisionGuards[`permitted.${c}`]=not(or(rejections[c]!.map(r=>r.guard)));
decisionGuards.humanResumable=resumable;
decisionGuards.commentResumable=and([resumable,not(fact('reply'))]);
decisionGuards.lastQuestion=and([inside('s_question'),not(fact('otherOpen'))]);
decisionGuards.claiming=and([agent,fact('claim')]);
export const permitted=(c:CardDecisionCommand,...conditions:any[])=>and([`permitted.${c}`,...conditions]);
