import type { CardRow, FolderActorParams, RepositorySql } from './control_plane/card_types.js';
import { claimableCardSessions } from './card_assignee.js';
import { readWorkExecution, readQueuedWork } from './card_work_lifecycle.js';
import { readPolicyAdmission } from './card_orchestration_repository.js';
import { readLimitAutoResumeAt, formatLimitResumeClock, type LimitResumeOwner } from './card_limit_auto_resume.js';
import { makeCardNow } from './card_item_rules.js';
import { serverCardEvidence, type ServerFenceEvidence } from './state/card_server_evidence.js';
import { CARD_SERVER_EVIDENCE_STAGES, type ServerCardCommand, type ServerEvidenceStage } from './state/card_server_command.js';
import type { CardBindingValues } from './state/card_write_intent.js';

/** Readers contain IO and SQL fences only. The machine alone chooses which reader runs next. */
export function cardServerEvidenceReader(sql:RepositorySql,card:CardRow,command:ServerCardCommand,actor:FolderActorParams) {
 const loaded:ServerEvidenceStage[]=[];
 const input:ServerFenceEvidence={loaded,actorSessionId:actor.actorSessionId};
 const readers:Partial<Record<ServerEvidenceStage,()=>Promise<void>>>={
  pending:async()=>{input.pendingRows=await sql`SELECT id FROM card_execution_requests WHERE card_id=${card.id} AND state='pending' LIMIT 1`;},
  policy:async()=>{input.policyEnabled=(await sql<{enabled:boolean}[]>`SELECT (value->>'enabled')::boolean AS enabled FROM system_settings WHERE setting_key='card_orchestration'`)[0]?.enabled===true;},
  claim:async()=>{input.claimCandidates=await claimableCardSessions(sql,card.id,actor.actorSessionId);},
 };
 let commit:(()=>Promise<void>)|undefined;
 switch(command.type){
 case 'START_WORK':{
  readers.execution=async()=>{input.execution=await readWorkExecution(sql,actor.actorSessionId!,command.execution);};
  readers.workAdmission=async()=>{
   const work=await readQueuedWork(sql,card,actor.actorSessionId!,command.execution);
   input.workAdmission=work;commit=work.commit;
  };
  break;
 }
 case 'CONFIRM_EXECUTION':{
  readers.executionSession=async()=>{input.sessionCardId=(await sql<{card_id:string}[]>`SELECT card_id FROM sessions WHERE session_id=${command.sessionId} FOR SHARE`)[0]?.card_id;};
  readers.executionStatus=async()=>{input.statusChanged=(await sql`SELECT c.status_changed_at>r.updated_at AS changed FROM cards c
        JOIN card_execution_requests r ON r.card_id=c.id WHERE c.id=${card.id} AND r.id=${command.requestId} AND r.session_id=${command.sessionId}`)[0]?.changed===true;};
  break;
 }
 case 'DISPATCH':case 'RESUME_LONG_LIMIT':{
  readers.admission=async()=>{
   const result=await readPolicyAdmission(sql,{cardId:card.id,cardVersion:command.expectedVersion,sessionId:command.sessionId,
    nodeId:command.nodeId??card.node_id??'eiaserinnys',...command.admission!});
   input.admission=result.result;commit=result.commit;
  };
  break;
 }
 case 'BLOCK_FOR_LIMIT':{
  readers.termination=async()=>{
   input.owner=(await sql<LimitResumeOwner[]>`SELECT session_id,status,termination_reason,termination_event_id FROM sessions WHERE session_id=${command.sessionId} FOR SHARE`)[0];
   input.terminationEventId=command.terminationEventId;
  };
  readers.limitReset=async()=>{input.resumeAt=await readLimitAutoResumeAt(sql,input.owner!);};
  break;
 }
 }
 const bindings:Pick<CardBindingValues,'values'|'lazy'>={lazy:{
  'evidence.resumeAt':()=>input.resumeAt,
  'formatted.limitDetail':()=>input.resumeAt?`사용량 한도, ${formatLimitResumeClock(input.resumeAt)} 자동 재개`:'세션 사용량 한도',
  'formatted.limit':()=>makeCardNow({text:`사용량 한도로 멈춤, ${formatLimitResumeClock(input.resumeAt!)}에 저절로 이어집니다`,turn:'outside'},new Date().toISOString(),null),
  'formatted.limitResume':()=>makeCardNow({text:'담당이 이어서 진행합니다',turn:'agent'},new Date().toISOString(),null),
  'formatted.verificationResume':()=>makeCardNow({text:'담당이 기다리던 것을 확인합니다',turn:'agent'},new Date().toISOString(),'sessionId' in command?command.sessionId:null),
  'formatted.replacement':()=>makeCardNow({text:'담당이 바뀌어 자동 재개 예약을 해제했습니다',turn:'agent'},new Date().toISOString(),actor.actorSessionId),
 }};
 return {
  bindings,maxDecisions:CARD_SERVER_EVIDENCE_STAGES[command.type].length+1,
  evidence:()=>serverCardEvidence(input),
  read:async(stage:ServerEvidenceStage)=>{await readers[stage]!();loaded.push(stage);},
  commit:async()=>{await commit?.();},
 };
}
