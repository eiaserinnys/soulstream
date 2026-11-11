import { CARD_REMAINING_EVIDENCE_STAGES } from './card_remaining_evidence.js';
import { CARD_SERVER_EVIDENCE_STAGES, admissionResults, type ServerCardCommand, type ServerEvidenceStage, type AdmissionResult } from './card_server_command.js';
import { parseVerificationWakeAt, WAITING_FOR_MAX_CODE_POINTS, VERIFICATION_WAIT_MAX_DAYS } from '../card_verification_wait.js';
import type { HumanCardCommand } from './card_human_command.js';
export const CARD_ACTORS=['human','owner','author','ownerAuthor','otherAgent','anonymousAgent','server','external'] as const;
export type CardActor=typeof CARD_ACTORS[number];
export const TARGETS=['todo','queued','running','question','noReport','other','limit','verification','review','hold','done','cancelled'] as const;
const flag=[false,true] as const;
const wait=['missing','empty','tooLong','invalid','past','withinWeek','tooLate'] as const;
const question=['missing','open','answered','withdrawn'] as const;
const admission=admissionResults;
/** One finite value inventory drives types and world enumeration. Stored regions are excluded. */
export const CARD_FACT_VALUES={
 CREATE:{queued:flag,assigneeInput:['none','agent','human','session'] as const},
 SET_STATUS:{target:TARGETS,claim:flag,wait},REQUEST_REVIEW:{claim:flag,hasItems:flag,hasAsk:flag},HUMAN_INPUT:{},
 ASK_QUESTION:{hasCurrentNow:flag},ANSWER_QUESTION:{question,otherOpen:flag},WITHDRAW_QUESTION:{question,otherOpen:flag},
 ADD_COMMENT:{entrance:['direct','followup'] as const,requestedSpoken:flag,claim:flag,reply:flag,hasItems:flag,hasMode:flag,userInput:flag,replyLength:['within','tooLong'] as const,hasItem:flag,itemExists:flag},
 START_WORK:{evidenceMissing:['none',...CARD_SERVER_EVIDENCE_STAGES.START_WORK] as const,claim:flag,execution:flag,admitted:flag,admissionReceipt:flag,admissionValid:flag},
 CONFIRM_EXECUTION:{evidenceMissing:['none',...CARD_SERVER_EVIDENCE_STAGES.CONFIRM_EXECUTION] as const,sessionMatch:flag,hasExecution:flag,statusChanged:flag,assignmentChanged:flag,hasNow:flag},
 DISPATCH:{evidenceMissing:['none',...CARD_SERVER_EVIDENCE_STAGES.DISPATCH] as const,pending:flag,policyEnabled:flag,hasAdmission:flag,admission},
 BLOCK_FOR_LIMIT:{evidenceMissing:['none',...CARD_SERVER_EVIDENCE_STAGES.BLOCK_FOR_LIMIT] as const,sessionMatch:flag,termination:flag,short:flag},
 RESUME_SHORT_LIMIT:{evidenceMissing:['none',...CARD_SERVER_EVIDENCE_STAGES.RESUME_SHORT_LIMIT] as const,sessionMatch:flag,due:flag,resumeTimeMatch:flag,pending:flag},
 RESUME_LONG_LIMIT:{evidenceMissing:['none',...CARD_SERVER_EVIDENCE_STAGES.RESUME_LONG_LIMIT] as const,sessionMatch:flag,pending:flag,policyEnabled:flag,hasAdmission:flag,admission},
 RESUME_VERIFICATION:{evidenceMissing:['none',...CARD_SERVER_EVIDENCE_STAGES.RESUME_VERIFICATION] as const,sessionMatch:flag,verificationTimeMatch:flag},NOTE_MISSING:{evidenceMissing:['none',...CARD_SERVER_EVIDENCE_STAGES.NOTE_MISSING] as const,},
 BULK_SET_STATUS:{hasOwnerSession:flag,evidenceMissing:['none',...CARD_REMAINING_EVIDENCE_STAGES.BULK_SET_STATUS] as const,target:['todo','queued','hold','cancelled'] as const,ownerState:['missing','running','initializing','idle'] as const,claim:flag},
 MERGE_SOURCE:{hasOwnerSession:flag,evidenceMissing:['none',...CARD_REMAINING_EVIDENCE_STAGES.MERGE_SOURCE] as const,pending:flag},UPDATE_UNSTARTED:{hasOwnerSession:flag,evidenceMissing:['none',...CARD_REMAINING_EVIDENCE_STAGES.UPDATE_UNSTARTED] as const,pending:flag,hasAgentInput:flag},
 SAVE_EXECUTION_SETTINGS:{hasOwnerSession:flag,evidenceMissing:['none',...CARD_REMAINING_EVIDENCE_STAGES.SAVE_EXECUTION_SETTINGS] as const,assigneeInput:['none','agent'] as const,pending:flag,assignmentChanged:flag,hasNow:flag,move:flag},
 PATCH_CARD_CONTROL:{hasArchiveInput:flag,assignmentChanged:flag,nextArchived:flag,hasNow:flag,hasAssignment:flag,assigneeInput:['none','agent','human','session'] as const},
 REGISTER_REPLACEMENT:{previousOwnerMatch:flag,hasNow:flag,assignmentChanged:flag},
} as const;
export type CardDecisionCommand=keyof typeof CARD_FACT_VALUES;
export type CommandFacts<C extends CardDecisionCommand> = { [K in keyof typeof CARD_FACT_VALUES[C]]:
 (typeof CARD_FACT_VALUES[C])[K] extends readonly (infer V)[] ? V : never };
type FactKey={ [C in CardDecisionCommand]:keyof typeof CARD_FACT_VALUES[C] }[CardDecisionCommand];
type FactValue<K extends FactKey>={ [C in CardDecisionCommand]:K extends keyof typeof CARD_FACT_VALUES[C] ?
 (typeof CARD_FACT_VALUES[C])[K] extends readonly (infer V)[] ? V : never : never }[CardDecisionCommand];
export type FiniteFacts=Partial<{[K in FactKey]:FactValue<K>}>;
export type RemainingCardCommand={type:Exclude<CardDecisionCommand,HumanCardCommand['type']|ServerCardCommand['type']>;[key:string]:any};
export type CardCommand=HumanCardCommand|ServerCardCommand|RemainingCardCommand;
export interface CardDecisionEvidence {
 loaded?:readonly ServerEvidenceStage[];
 claim?:boolean;userInput?:boolean;execution?:boolean;admitted?:boolean;admissionReceipt?:boolean;admissionValid?:boolean;
 sessionCardId?:string;statusChanged?:boolean;pending?:boolean;policyEnabled?:boolean;admission?:AdmissionResult;
 termination?:boolean;resumeAt?:Date|string|null;ownerState?:string;previousOwnerMatch?:boolean;
}
export type DecisionEvent={type:CardDecisionCommand;actor:CardActor;facts:FiniteFacts};
export function* enumerateCardFacts(command:CardDecisionCommand):Generator<FiniteFacts> {
 const entries=Object.entries(CARD_FACT_VALUES[command]);
 function* walk(i:number,row:FiniteFacts):Generator<FiniteFacts>{if(i===entries.length){yield row;return;}
 const [key,values]=entries[i]!;for(const value of values)yield*walk(i+1,{...row,[key]:value});}
 yield*walk(0,{});
}
export function deriveCardActor(row:Record<string,any>|null,questions:readonly Record<string,any>[],command:{type:CardDecisionCommand;[key:string]:any},actor:Record<string,any>):CardActor {
 if(actor.kind==='user')return 'human';if(actor.kind==='system')return 'server';if(actor.kind!=='agent')return 'external';if(!actor.sessionId)return 'anonymousAgent';
 const owner=row?.assignee_kind==='session'&&row.assignee_session_id===actor.sessionId;
 const author=questions.some(q=>q.id===command.questionId&&q.session_id===actor.sessionId);
 return owner?(author?'ownerAuthor':'owner'):author?'author':'otherAgent';
}
/** Equality, presence, temporal and input-shape partitions only. SQL checks are supplied as evidence. */
export function deriveCardDecisionFacts(row:Record<string,any>|null,questions:readonly Record<string,any>[],evidence:CardDecisionEvidence,command:{type:CardDecisionCommand;[key:string]:any},actor:Record<string,any>,checkedAt:number):FiniteFacts {
 const c=row??{},q=questions.find(q=>q.id===command.questionId);
 const target=command.status==='blocked'?command.blockedKind==='question'?'question':command.blockedKind==='limit'?'limit':command.blockedKind==='no_report'?'noReport':'other':command.status==='awaiting_verification'?'verification':command.status==='on_hold'?'hold':command.status;
 let waiting:typeof wait[number]='missing';
 if(command.wakeAt!==undefined&&command.waitingFor!==undefined){const length=[...String(command.waitingFor).trim()].length,at=parseVerificationWakeAt(String(command.wakeAt));
 waiting=!length?'empty':length>WAITING_FOR_MAX_CODE_POINTS?'tooLong':!at?'invalid':at.getTime()<=checkedAt?'past':at.getTime()-checkedAt>VERIFICATION_WAIT_MAX_DAYS*86400000?'tooLate':'withinWeek';}
 const assignee=command.assignee;
 const assignment=Object.hasOwn(command,'assignee')&&(assignee?.kind??null)!==c.assignee_kind||Object.hasOwn(command,'assignee')&&assignee?.kind==='session'&&assignee.sessionId!==c.assignee_session_id;
 const stageMap:Partial<Record<CardDecisionCommand,readonly ServerEvidenceStage[]>>={...CARD_SERVER_EVIDENCE_STAGES,...CARD_REMAINING_EVIDENCE_STAGES};
 const stages=stageMap[command.type];
 const evidenceMissing=stages?.find(stage=>!evidence.loaded?.includes(stage))??'none';
 const all:Record<string,any>={hasOwnerSession:c.assignee_session_id!=null,evidenceMissing,target,queued:command.queue===true,assigneeInput:command.type==='SAVE_EXECUTION_SETTINGS'?(command.agentId?'agent':'none'):assignee?.kind??'none',claim:evidence.claim===true,wait:waiting,
 hasCurrentNow:c.now!=null,hasItems:(c.items??[]).length>0,hasAsk:command.ask!==undefined,question:!q?'missing':q.answer!==null?'answered':q.withdrawn_at!==null?'withdrawn':'open',
 otherOpen:questions.some(other=>other.id!==command.questionId&&other.answer===null&&other.withdrawn_at===null),
 entrance:command.entrance??'direct',requestedSpoken:command.kind==='spoken',reply:command.mode==='reply',hasMode:command.mode!==undefined,userInput:evidence.userInput===true,replyLength:[...String(command.body??'')].length>300?'tooLong':'within',
 hasItem:command.itemId!==undefined,itemExists:(c.items??[]).some((item:any)=>item.id===command.itemId),
 execution:evidence.execution===true,admitted:evidence.admitted===true,admissionReceipt:evidence.admissionReceipt===true,admissionValid:evidence.admissionValid===true,
 sessionMatch: c.assignee_session_id?c.assignee_session_id===command.sessionId:evidence.sessionCardId===c.id,
 hasExecution:command.execution!==undefined,statusChanged:evidence.statusChanged===true,assignmentChanged:['CONFIRM_EXECUTION','REGISTER_REPLACEMENT'].includes(command.type)?c.assignee_session_id!==command.sessionId||c.assignee_kind!=='session':command.type==='SAVE_EXECUTION_SETTINGS'?(command.agentId?'agent':null)!==c.assignee_kind:assignment,
 pending:evidence.pending===true,policyEnabled:evidence.policyEnabled===true,hasAdmission:command.admission!==undefined,admission:evidence.admission??'ok',
 termination:evidence.termination===true,short:evidence.resumeAt!=null,due:c.limit_resume_at!=null&&new Date(c.limit_resume_at).getTime()<=Number(command.now),
 resumeTimeMatch:c.limit_resume_at!=null&&new Date(c.limit_resume_at).toISOString()===command.resumeAt,
 verificationTimeMatch:c.wake_at!=null&&new Date(c.wake_at).toISOString()===command.wakeAt,
 ownerState:evidence.ownerState??'missing',hasNow:command.now!==undefined,nextArchived:command.archived===undefined?c.archived===true:command.archived===true,
 hasArchiveInput:command.archived!==undefined,hasAgentInput:command.agentId!==undefined,hasAssignment:Object.hasOwn(command,'assignee'),move:command.folderId!==undefined&&command.folderId!==c.folder_id,previousOwnerMatch:evidence.previousOwnerMatch===true};
 if(stages){
  const stageFields:Partial<Record<ServerEvidenceStage,string[]>>={execution:['execution'],workAdmission:['admitted','admissionReceipt','admissionValid'],claim:['claim'],
   ownerState:['ownerState'],executionStatus:['statusChanged'],pending:['pending'],policy:['policyEnabled'],admission:['admission'],termination:['termination'],limitReset:['short']};
  for(const stage of stages)if(!evidence.loaded?.includes(stage))for(const key of stageFields[stage]??[])delete all[key];
  if(command.type==='CONFIRM_EXECUTION'&&!evidence.loaded?.includes('executionSession'))delete all.sessionMatch;
 }
 return Object.fromEntries(Object.keys(CARD_FACT_VALUES[command.type]).filter(key=>all[key]!==undefined).map(key=>[key,all[key]]));
}
