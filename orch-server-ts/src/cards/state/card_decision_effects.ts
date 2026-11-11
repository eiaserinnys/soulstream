import { and, or, not } from 'xstate';
import { CARD_DECISION_SOURCES, CARD_COMMAND_ENTRANCES, CARD_COMMAND_CALLERS } from './card_decision_inventory.js';
import { CARD_FACT_VALUES, TARGETS, type CardDecisionCommand } from './card_decision_facts.js';
import { decisionGuards, permitted, inside, any, fact } from './card_decision_guards.js';
import { bind, literal, type CardBinding } from './card_write_intent.js';
export const COMMAND_LABELS:Record<CardDecisionCommand,string>={CREATE:'카드를 만든다',SET_STATUS:'상태를 옮긴다',REQUEST_REVIEW:'검수를 요청한다',HUMAN_INPUT:'사용자가 담당에게 말한다',ASK_QUESTION:'질문을 올린다',ANSWER_QUESTION:'질문에 답한다',WITHDRAW_QUESTION:'질문을 철회한다',ADD_COMMENT:'커멘트를 남긴다',START_WORK:'작업 착수를 확인한다',CONFIRM_EXECUTION:'서버가 실행을 확인한다',DISPATCH:'서버가 실행을 배정한다',BLOCK_FOR_LIMIT:'현재 담당의 한도 종료를 기록한다',RESUME_SHORT_LIMIT:'짧은 한도 시각이 되어 잇는다',RESUME_LONG_LIMIT:'시각 없는 한도 예약을 잇는다',RESUME_VERIFICATION:'검증 시각이 되어 잇는다',NOTE_MISSING:'담당 에이전트 없음을 적는다',BULK_SET_STATUS:'여러 카드의 상태를 옮긴다',MERGE_SOURCE:'시작 전 카드를 합쳐 닫는다',UPDATE_UNSTARTED:'시작 전 카드를 고친다',SAVE_EXECUTION_SETTINGS:'실행 설정을 저장한다',PATCH_CARD_CONTROL:'담당과 보관을 고친다',REGISTER_REPLACEMENT:'등록된 새 담당으로 바꾼다',CLAIM:'연결된 작업 세션이 담당을 맡는다'};
export const COMMAND_RULES:Partial<Record<CardDecisionCommand,string>>={
 SET_STATUS:'현재 담당 권한과 검증 대기 입력을 확인한다. 같은 done 재지정도 완료 정보를 다시 쓰고 같은 queued 재지정도 새 대기열 순서 키를 요청한다.',
 HUMAN_INPUT:'보관되지 않은 세션 담당의 검증 대기 또는 한도 아닌 막힘을 재개하고 열린 질문을 모두 닫는다.',
 ASK_QUESTION:'다른 세션 담당 여부를 확인하고 질문 행을 추가한다. 질문 막힘으로 옮기며 완료 정보와 대기열 순서를 지운다.',
 ANSWER_QUESTION:'사람만 열린 질문에 답한다. 마지막 열린 질문이고 질문 막힘일 때만 실행 중으로 옮긴다. 완료 뒤 늦은 답은 상태를 보존한다.',
 WITHDRAW_QUESTION:'질문 작성자 또는 현재 담당 세션이 철회한다. 마지막 질문 막힘일 때만 실행 중으로 옮긴다.',
 ADD_COMMENT:'직접 입구는 prepare 검사 뒤 다른 담당 검사를 먼저 한다. dispatch_work의 Tx 후속 입구는 이 검사를 하지 않는다. reply의 담당, 길이와 사용자 입력을 확인한다. non-reply이면 사람뿐 아니라 담당의 spoken도 말로 풀리는 기다림을 재개한다. claim과 항목과 상태 UPDATE는 나눈다.',
 DISPATCH:'queued와 미확인 실행 요청을 확인한다. 정책 설정과 admission 증거에 따라 허가를 확인하고, admission이면 queued 유지, 기존 실행이면 running으로 옮긴다.',
 BLOCK_FOR_LIMIT:'현재 실행 중 담당의 최신 한도 종료가 일치할 때 담당 예약을 기록한다. 짧은 한도는 시각을, 긴 한도는 담당만 기록한다.',
 RESUME_SHORT_LIMIT:'현재 담당과 기록된 예약이 일치하고 같은 시각이 도래했을 때만 재개한다.',
 RESUME_LONG_LIMIT:'시각 없는 예약의 현재 담당만 재개한다. 정책 설정과 admission 확인을 함께 적용한다.',
 RESUME_VERIFICATION:'기록한 검증 시각과 담당이 일치하면 예약을 지우고 재개한다. 도래 선별과 실제 깨우기는 호출부가 한다.',
 PATCH_CARD_CONTROL:'명시한 담당과 보관만 바꾼다. 담당 교체와 보관 또는 한도 탈출은 한도 예약을 함께 지운다. 명시적 status 쓰기가 없으면 검증 예약은 보존한다.',
 CONFIRM_EXECUTION:'요청 세션을 담당으로 연결한다. 요청 이후 상태가 바뀐 뒤늦은 확인은 상태와 완료 정보를 보존한다.',
};
export const effects:Record<string,Record<string,any[]>>=Object.fromEntries(['status','question','reservation','assignee','archive'].map(r=>[r,{}]));
export const verdictExtras:Record<string,any[]>=Object.fromEntries(Object.keys(CARD_FACT_VALUES).map(c=>[c,[]]));
export const write=(fields:Record<string,CardBinding>,stage='state',kind='card')=>({type:'write',params:{stage,kind,fields}});
export const mark=(type:string,stage='state')=>({type,params:{stage}});
const clearCompletion=()=>write(Object.fromEntries(['completed_kind','completed_session_id','completed_user_id','completed_event_id','completed_at'].map(k=>[k,literal(null)])));
const complete=()=>write({completed_kind:bind('completion.kind'),completed_session_id:bind('actor.session'),completed_user_id:bind('actor.user'),completed_event_id:bind('event.id'),completed_at:bind('clock')});
const claim=(stage='state')=>[mark('writeAssignee',stage),write({assignee_session_id:bind('actor.session'),assignee_agent_id:literal(null)},stage)];
function put(region:string,c:CardDecisionCommand,target:string|undefined,conditions:any[]=[],actions:any[]=[],description=COMMAND_LABELS[c]) {
 const list=effects[region]![c]??=[];
 list.push({...(target?{target:`#${target}`} : {}),guard:permitted(c,...conditions),actions,description,meta:{command:c,label:description,callers:CARD_COMMAND_CALLERS[c],sources:CARD_DECISION_SOURCES[c],entrances:CARD_COMMAND_ENTRANCES[c],rule:COMMAND_RULES[c]??COMMAND_LABELS[c]}});
}
function patchExtras(c:CardDecisionCommand,target:string,extra:any[]=[]){
 const general=['SET_STATUS','BULK_SET_STATUS','REQUEST_REVIEW','HUMAN_INPUT'].includes(c);
 const actions:any[]=[mark('writeStatus'),write({blocked_detail:['question','limit','noReport','other'].includes(target)?bind('command.blockedDetail.nullable'):literal(null)}),...extra];
 if(general)actions.push(target==='done'?complete():clearCompletion());
 if(['ASK_QUESTION','START_WORK','CONFIRM_EXECUTION','MERGE_SOURCE'].includes(c))actions.push(clearCompletion());
 if(general)actions.push(write({queue_position_key:target==='queued'?bind('queue.new'):target==='limit'?bind('card.queue_position_key'):literal(null)}));
 if(['ASK_QUESTION','START_WORK','CONFIRM_EXECUTION','RESUME_SHORT_LIMIT','RESUME_VERIFICATION','MERGE_SOURCE'].includes(c))actions.push(write({queue_position_key:literal(null)}));
 if(target!=='verification'){
  const cleanup=write({wake_at:literal(null),waiting_for:literal(null)});
  actions.push({...cleanup,params:{...cleanup.params,normalization:true}});
 }
 return actions;
}
function status(c:CardDecisionCommand,target:string,conditions:any[]=[],extra:any[]=[]){
 put('status',c,`s_${target}`,conditions,patchExtras(c,target,extra));
 if(target==='verification')put('reservation',c,'r_verify',conditions,[write({wake_at:bind('command.wakeAt.iso'),waiting_for:bind('command.waitingFor.trimmed')}),mark('clearLimit')]);
 else if(target!=='limit')put('reservation',c,'r_none',conditions,[mark('clearLimit')]);
 else put('reservation',c,'r_none',[...conditions,or([inside('arch_archived'),inside('r_verify')])],[mark('clearLimit')]);
}
for(const c of ['SET_STATUS','BULK_SET_STATUS'] as const)for(const target of TARGETS)status(c,target,[fact('target',target)],target==='verification'?[write({now:bind('formatted.verification')})]:[]);
for(const target of ['todo','queued'])status('CREATE',target,[fact('queued',target==='queued')],[write({archived:literal(false),queue_position_key:target==='queued'?bind('queue.new'):literal(null)})]);
status('REQUEST_REVIEW','review');
status('ASK_QUESTION','question',[],[write({blocked_detail:bind('command.text')})]);
status('HUMAN_INPUT','running',['humanResumable']);status('ADD_COMMENT','running',['commentResumable']);
for(const c of ['ANSWER_QUESTION','WITHDRAW_QUESTION'] as const)status(c,'running',['lastQuestion']);
status('START_WORK','running');
status('CONFIRM_EXECUTION','running',[fact('hasExecution'),not(fact('statusChanged'))]);
for(const c of ['DISPATCH','RESUME_LONG_LIMIT'] as const){status(c,'queued',[fact('hasAdmission')]);status(c,'running',[not(fact('hasAdmission'))],[write({queue_position_key:literal(null)})]);}
status('BLOCK_FOR_LIMIT','limit',[],[write({blocked_detail:bind('formatted.limitDetail'),queue_position_key:bind('card.queue_position_key')})]);
status('RESUME_SHORT_LIMIT','running',[],[write({now:bind('formatted.limitResume')})]);
status('RESUME_VERIFICATION','running',[],[write({now:bind('formatted.verificationResume')})]);
status('MERGE_SOURCE','cancelled',[],[write({now:bind('formatted.merge')})]);
// NOTE_MISSING changes the queued substate only when already queued; it writes
// the detail on every status, without inventing an eligibility restriction.
put('status','NOTE_MISSING','s_missing',[any('s_queued','s_missing')]);
verdictExtras.NOTE_MISSING!.push(write({blocked_detail:literal('담당 에이전트 없음')}));
put('question','ASK_QUESTION','q_open',[],[write({session_id:bind('actor.session'),text:bind('command.text'),options:bind('command.options')},'question','questionInsert')]);
for(const c of ['ANSWER_QUESTION','WITHDRAW_QUESTION'] as const){
 put('question',c,'q_none',[not(fact('otherOpen'))]);
 verdictExtras[c]!.push(c==='ANSWER_QUESTION'?write({answer:bind('command.answer'),answered_at:bind('clock'),answered_by:bind('actor.user')},'question','questionAnswer'):
 write({withdrawn_at:bind('clock'),withdrawn_by_session_id:bind('actor.session'),withdrawal_reason:bind('command.reason.trimmed')},'question','questionWithdraw'));
}
for(const c of ['HUMAN_INPUT','ADD_COMMENT'] as const)put('question',c,'q_none',[c==='HUMAN_INPUT'?'humanResumable':'commentResumable'],[write({withdrawn_at:bind('clock'),withdrawn_by_session_id:literal(null),withdrawal_reason:literal(c==='HUMAN_INPUT'?'사용자 메시지로 작업이 재개되어 서버가 닫았습니다':'사용자가 커멘트로 답해 서버가 닫았습니다')},'questions','closeQuestions')]);
for(const c of ['SET_STATUS','BULK_SET_STATUS','REQUEST_REVIEW','START_WORK','CLAIM'] as const)put('assignee',c,'a_session',['claiming'],claim());
put('assignee','ADD_COMMENT','a_session',['claiming',fact('reply')],claim('claim'));
put('assignee','START_WORK','a_session',[fact('admitted')],claim());
put('assignee','CONFIRM_EXECUTION','a_session',[],[mark('writeAssignee'),write({assignee_session_id:bind('command.sessionId'),assignee_agent_id:literal(null)})]);
for(const kind of ['none','agent','human','session']){
 put('assignee','PATCH_CARD_CONTROL',`a_${kind}`,[fact('hasAssignment'),fact('assigneeInput',kind)],[mark('writeAssignee'),{type:'spreadControl',params:{stage:'state'}}]);
 put('assignee','CREATE',`a_${kind}`,[fact('assigneeInput',kind)],[mark('writeAssignee'),{type:'spreadCreateAssignment',params:{stage:'state'}}]);
}
put('assignee','UPDATE_UNSTARTED','a_agent',[fact('hasAgentInput')],[mark('writeAssignee')]);
put('assignee','REGISTER_REPLACEMENT','a_session',[],[mark('writeAssignee'),write({assignee_session_id:bind('command.sessionId'),assignee_agent_id:literal(null)})]);
for(const kind of ['none','agent'])put('assignee','SAVE_EXECUTION_SETTINGS',`a_${kind}`,[fact('assigneeInput',kind)],[mark('writeAssignee')]);
for(const archived of [true,false])put('archive','PATCH_CARD_CONTROL',archived?'arch_archived':'arch_active',[fact('hasArchiveInput'),fact('nextArchived',archived)],[mark('writeArchive')]);
for(const short of [true,false])put('reservation','BLOCK_FOR_LIMIT',short?'r_limit':'r_longLimit',[fact('short',short)],[write({limit_resume_session_id:bind('command.sessionId'),limit_resume_at:short?bind('evidence.resumeAt'):literal(null)})]);
for(const c of ['PATCH_CARD_CONTROL','SAVE_EXECUTION_SETTINGS','REGISTER_REPLACEMENT','CLAIM','NOTE_MISSING','UPDATE_UNSTARTED'] as const){
 const changed=c==='REGISTER_REPLACEMENT'?()=>true:c==='CLAIM'?fact('claim'):fact('assignmentChanged');
 const clean=[...(c==='CLAIM'?[fact('claim')]:[]),or([not(inside('s_limit')),inside('arch_archived'),...(c==='PATCH_CARD_CONTROL'?[fact('nextArchived')]:[]),changed])];
 put('reservation',c,'r_none',[...clean,not(inside('r_verify'))],[mark('clearLimit')]);
 put('reservation',c,undefined,[...clean,inside('r_verify')],[mark('clearLimit')]);
}
for(const c of ['SET_STATUS','REQUEST_REVIEW','START_WORK','ADD_COMMENT','CONFIRM_EXECUTION'] as const){
 const changed=c==='CONFIRM_EXECUTION'?fact('assignmentChanged'):and(['claiming',...(c==='ADD_COMMENT'?[fact('reply')]:[])]);
 put('reservation',c,'r_none',[changed,not(inside('r_verify'))],[mark('clearLimit',c==='ADD_COMMENT'?'claim':'state')]);
 put('reservation',c,undefined,[changed,inside('r_verify')],[mark('clearLimit',c==='ADD_COMMENT'?'claim':'state')]);
}
function augment(region:string,c:CardDecisionCommand,condition:any,actions:any[]) {
 const list=effects[region]![c]??[{guard:permitted(c),actions:[],description:COMMAND_LABELS[c],meta:{command:c,label:COMMAND_LABELS[c],callers:CARD_COMMAND_CALLERS[c],sources:CARD_DECISION_SOURCES[c],entrances:CARD_COMMAND_ENTRANCES[c],rule:COMMAND_RULES[c]??COMMAND_LABELS[c]}}];
 effects[region]![c]=list.flatMap(rule=>[
 {...rule,guard:and([rule.guard,condition]),actions:[...rule.actions,...actions]},
 {...rule,guard:and([rule.guard,not(condition)])},
 ]);
}
// Symbolic writes which do not follow directly from a region target.
// Conditional targetless transitions live in their effect region, separate from verdict priority.
put('question','REQUEST_REVIEW',undefined,[fact('hasAsk')],[write({now:bind('formatted.review')})]);
for(const c of ['PATCH_CARD_CONTROL','SAVE_EXECUTION_SETTINGS','UPDATE_UNSTARTED'] as const)verdictExtras[c]!.push({type:'spreadControl',params:{stage:'state'}});
for(const c of ['PATCH_CARD_CONTROL','SAVE_EXECUTION_SETTINGS','REGISTER_REPLACEMENT','CONFIRM_EXECUTION'] as const)
 augment('archive',c,and([fact('assignmentChanged'),any('r_limit','r_longLimit'),not(fact('hasNow'))]),[write({now:bind('formatted.replacement')})]);
put('archive','ASK_QUESTION',undefined,[fact('hasCurrentNow')],[write({now:bind('formatted.question')})]);
put('archive','BLOCK_FOR_LIMIT',undefined,[fact('short')],[write({now:bind('formatted.limit')})]);
put('archive','ADD_COMMENT',undefined,[fact('hasItem'),not(fact('reply'))],[write({items:bind('formatted.items')},'item')]);

put('question','SAVE_EXECUTION_SETTINGS',undefined,[fact('move')],[write({folder_id:bind('command.folderId'),position_key:bind('folder.new')},'move')]);
