import { isUsageLimitTermination } from '../../session/session_limit_termination.js';
import type { LimitResumeOwner } from '../card_limit_auto_resume.js';
import type { CardWorkExecution } from '../card_work_lifecycle.js';
import type { CardDecisionEvidence } from './card_decision_facts.js';
import { CARD_SERVER_EVIDENCE_STAGES, type ServerEvidenceStage, type AdmissionResult } from './card_server_command.js';

export interface EvidenceSession extends LimitResumeOwner {
 card_id?:string;execution_registration_id?:string;execution_command_id?:string;
 metadata?:{type:string}[];node_id?:string;agent_id?:string;model_preset?:string|null;
}
export interface EvidenceRun {id:string;state:string;lease_token:string;lease_expires_at:string|Date;policy_version:number;
 decision?:{decisions:{cardId:string;cardVersion:number;action:string}[]}|null}
export interface EvidenceCard {id:string;version:number;archived:boolean;folder_id:string;assignee_kind:string|null;
 assignee_session_id:string|null;assignee_agent_id:string|null;node_id:string|null;model_preset:string|null}
export interface EvidenceDispatch {session_id:string;run_id:string;state:string;launch_accepted:boolean;node_id:string;created_at:string|Date;
 input:{deliveryId?:string;agentId?:string;modelPreset?:string|null;admittedCardVersion?:number}}
interface Registration {session_id:string;event_id:number;created_at:string|Date;
 effect_application?:{applied?:boolean;canonical_execution_registration?:{registration_id?:string;execution_command_id?:string}|null}}
export interface ServerEvidenceRows {
 sessions:EvidenceSession[];registrations:Registration[];
 deliveries:{delivery_id:string;target_session_id:string;state:string;target_receipt_id:string}[];
 dispatchRuns:EvidenceRun[];admissionRun?:EvidenceRun|null;
 orchestrationPolicy?:{version:unknown;value:{enabled?:boolean}}|null;
 dispatchPolicy?:{value:{nodeConcurrency?:Record<string,number>}}|null;
 folders:{id:string;archived:boolean}[];capacitySessions:{session_id:string;node_id:string}[];
 executionStatusChanged:boolean;
}
export interface ServerEvidenceCommand {type:string;sessionId?:string;nodeId?:string;expectedVersion?:number;execution?:CardWorkExecution;terminationEventId?:number|null;
 admission?:{runId:string;leaseToken:string;workerInput:Record<string,unknown>}}
export interface ServerFenceEvidence {
 loaded:readonly ServerEvidenceStage[];execution?:boolean;workAdmission?:{receipt:boolean;valid:boolean};
 claimCandidates?:readonly {session_id:string}[];actorSessionId?:string|null;
 sessionCardId?:string|null;statusChanged?:boolean;pendingRows?:readonly unknown[];policyEnabled?:boolean;
 admission?:AdmissionResult;owner?:LimitResumeOwner;terminationEventId?:number|null;resumeAt?:Date|null;
}
export function workExecutionMatches(worker:EvidenceSession|undefined,execution:CardWorkExecution|undefined):boolean {
 return !!worker&&worker.execution_registration_id===execution?.registrationId&&worker.execution_command_id===execution?.executionCommandId
  &&!['completed','error','interrupted'].includes(worker.status??'')&&!(worker.metadata??[]).some(m=>m.type==='card_orchestration_decision');
}
export function admissionRunMatches(run:Pick<EvidenceRun,'policy_version'|'decision'>|undefined|null,policyVersion:number,cardId:string,version:number):boolean {
 return !!run&&run.policy_version===policyVersion&&!!run.decision?.decisions.some(d=>d.cardId===cardId&&d.cardVersion===version&&d.action==='run');
}
export function admissionCapacityResult(capacity:number|undefined,occupied:readonly {session_id:string;node_id:string}[],sessionId:string,nodeId:string):AdmissionResult {
 return capacity===undefined?'missingCapacity':occupied.filter(r=>r.node_id===nodeId).length>=capacity&&!occupied.some(r=>r.session_id===sessionId&&r.node_id===nodeId)?'capacity':'ok';
}
export function workAdmissionMatches(card:Pick<EvidenceCard,'assignee_kind'|'assignee_session_id'|'assignee_agent_id'>,sessionId:string,agentId:unknown,matched:boolean):boolean {
 return matched&&(card.assignee_kind==='session'?card.assignee_session_id===sessionId:card.assignee_kind==='agent'&&card.assignee_agent_id===agentId);
}

/** One pure constructor for runtime fence results and frozen-row replay. No state permissions live here. */
export function serverCardEvidence(input:ServerFenceEvidence|{rows:ServerEvidenceRows;card:EvidenceCard;command:ServerEvidenceCommand;
 actorSessionId:string|null;checkedAt:number;dispatches:EvidenceDispatch[];requests:{state:string}[];claimCandidates:{session_id:string}[];resumeAt:Date|null}):CardDecisionEvidence {
 if('rows' in input){
  const {rows:r,card:c,command:q,actorSessionId:s,checkedAt}=input;
  const worker=r.sessions.find(w=>w.session_id===s),owner=r.sessions.find(w=>w.session_id===c.assignee_session_id);
  const active=input.dispatches.find(d=>d.session_id===s&&['admitted','launching'].includes(d.state));
  const registered=(p:Registration)=>p.effect_application?.applied===true&&p.effect_application.canonical_execution_registration?.registration_id===q.execution?.registrationId&&p.effect_application.canonical_execution_registration?.execution_command_id===q.execution?.executionCommandId;
  let receipt=false;
  if(active){
   if(active.input.deliveryId){
    const delivery=r.deliveries.find(d=>d.delivery_id===active.input.deliveryId&&d.target_session_id===s&&d.state==='consumed');
    const eventId=delivery&&/^event:\d+$/.test(delivery.target_receipt_id)?Number(delivery.target_receipt_id.slice(6)):-1;
    const registration=r.registrations.filter(p=>p.session_id===s&&p.event_id<=eventId&&p.effect_application?.applied===true&&p.effect_application.canonical_execution_registration).at(-1);
    receipt=!!registration&&registered(registration);
   }else receipt=r.registrations.some(p=>p.session_id===s&&registered(p)&&new Date(p.created_at)>=new Date(active.created_at));
  }
  const enabled=r.orchestrationPolicy?.value.enabled===true,policyVersion=Number(r.orchestrationPolicy?.version);
  const run=active&&r.dispatchRuns.find(run=>run.id===active.run_id);
  const valid=!!active&&active.state==='launching'&&active.launch_accepted&&enabled&&policyVersion===run?.policy_version&&worker?.node_id===active.node_id&&worker?.agent_id===active.input.agentId&&worker?.model_preset===(active.input.modelPreset??null)&&Number(active.input.admittedCardVersion)===c.version;
  const admission=q.admission,admissionRun=r.admissionRun;
  let outcome:AdmissionResult='ok';
  if(admission){
   if(!admissionRun||admissionRun.state!=='decided'||admissionRun.lease_token!==admission.leaseToken||new Date(admissionRun.lease_expires_at).getTime()<=checkedAt||!admissionRunMatches(admissionRun,policyVersion,c.id,c.version))outcome='stale';
   else{
    outcome=admissionCapacityResult(r.dispatchPolicy?.value.nodeConcurrency?.[q.nodeId!]??r.dispatchPolicy?.value.nodeConcurrency?.default,r.capacitySessions,q.sessionId!,q.nodeId!);
    const folder=r.folders.find(f=>f.id===c.folder_id),a=admission.workerInput;
    const eligible=!c.archived&&!folder?.archived&&(c.assignee_kind==='agent'&&c.assignee_agent_id===a.agentId&&(c.node_id??'eiaserinnys')===q.nodeId&&c.model_preset===(a.configuredModelPreset??null)
     ||c.assignee_kind==='session'&&!!owner&&owner.session_id===q.sessionId&&owner.node_id===q.nodeId&&owner.agent_id===a.agentId&&owner.model_preset===(a.modelPreset??null));
    if(outcome==='ok'&&!eligible)outcome='ineligible';
   }
  }
  return {...serverCardEvidence({loaded:[...new Set(Object.values(CARD_SERVER_EVIDENCE_STAGES).flat())],execution:workExecutionMatches(worker,q.execution),
   workAdmission:{receipt,valid:workAdmissionMatches(c,s!,active?.input.agentId,valid)},claimCandidates:input.claimCandidates,actorSessionId:s,
   sessionCardId:r.sessions.find(w=>w.session_id===q.sessionId)?.card_id,statusChanged:r.executionStatusChanged,pendingRows:input.requests.filter(q=>q.state==='pending'),
   policyEnabled:enabled,admission:outcome,owner,terminationEventId:q.terminationEventId,resumeAt:input.resumeAt})};
 }
 const e:CardDecisionEvidence={loaded:input.loaded};
 // Missing steps stay absent, rather than becoming negative evidence.
 for(const stage of input.loaded)switch(stage){
 case 'execution':e.execution=input.execution;break;
 case 'workAdmission':e.admissionReceipt=input.workAdmission!.receipt;e.admissionValid=input.workAdmission!.valid;e.admitted=e.admissionReceipt&&e.admissionValid;break;
 case 'claim':e.claim=!!input.actorSessionId&&!!input.claimCandidates?.some(s=>s.session_id===input.actorSessionId);break;
 case 'executionSession':e.sessionCardId=input.sessionCardId??undefined;break;
 case 'executionStatus':e.statusChanged=input.statusChanged;break;
 case 'pending':e.pending=!!input.pendingRows?.length;break;
 case 'policy':e.policyEnabled=input.policyEnabled;break;
 case 'admission':e.admission=input.admission;break;
 case 'termination':e.termination=!!input.owner&&isUsageLimitTermination(input.owner)&&input.owner.termination_event_id===input.terminationEventId;break;
 case 'limitReset':e.resumeAt=input.resumeAt;break;
 }
 return e;
}
