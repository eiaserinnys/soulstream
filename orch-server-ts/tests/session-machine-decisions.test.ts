import { expect,it } from 'vitest';
import { PendingNodeCommandTimeoutError } from '../src/node/pending_commands.js';
import { decideResumeDispatch } from '../src/schedule/resume_dispatch_decision.js';
import { deleteSessionWithNode, SessionDeleteError } from '../src/session/session_delete.js';
import {
  decideSessionTransition,
  type SessionDecision,
} from '../src/session/state/session_decision.js';
import {
  SESSION_COMMANDS,
  SESSION_TABLE_COMMAND,
  type SessionCommand,
  type SessionDecisionCommand,
  type FiniteFacts,
} from '../src/session/state/session_decision_facts.js';
import {
  SESSION_ACKNOWLEDGE_STATES,
  SESSION_TABLE_STATES,
  sessionDecisionTable,
  type SessionDecisionRow,
} from '../src/session/state/session_decision_table.js';
import {
  checkSessionPromises,
  SESSION_PROMISES,
} from '../src/session/state/session_machine_promises.js';
import type { SessionStateValue } from '../src/session/state/session_state_value.js';

function state(
  status: SessionStateValue['status'],
  termination: SessionStateValue['termination'] = 'none',
  review: SessionStateValue['review'] = 'not_required',
): SessionStateValue {
  return { status, termination, review, reservation: 'none', verdict: 'ready' };
}

const tableStates: readonly SessionStateValue[] = [
  ...SESSION_TABLE_STATES,
  ...SESSION_ACKNOWLEDGE_STATES.slice(2),
];

it('fills every cell of the decision table with a verdict',()=>{
 const rows=sessionDecisionTable();
 expect(rows).toHaveLength(283);
 const counts=Object.fromEntries(SESSION_COMMANDS.map(command=>[command,0]));
 for(const row of rows){
 expect(['apply','noop','reject']).toContain(row.decision.kind);
 expect(row.decision.reason).toBeTruthy();
 counts[row.command.type]=(counts[row.command.type]??0)+1;
 }
 expect(counts).toEqual({
 register:7,
 execution_registration:42,
 running_transition:42,
 terminal_transition:13,
 node_disconnect_cleanup:14,
 startup_reconcile_missing:18,
 startup_reconcile_restore:28,
 stale_registration:21,
 session_update_status:7,
 acknowledge_review:14,
 delete:35,
 resume_dispatch:42,
 });
 for(const command of SESSION_COMMANDS){
 const payload=SESSION_TABLE_COMMAND[command];
 const seen=new Set<string>();
 for(const value of tableStates){
 for(const reviewRequired of [false,true]){
 const decision=decideSessionTransition(value,payload,{reviewRequired});
 expect(decision.kind,`${command} ${JSON.stringify(value)}`).toMatch(/^(apply|noop|reject)$/);
 seen.add(decision.kind);
 }
 }
 expect(seen.size,`${command}가 어떤 상태에서도 같은 판정만 낸다`).toBeGreaterThan(0);
 }
});

it('writes the command payload into the next state',()=>{
 for(const target of ['completed','error','interrupted'] as const){
 const decision=decideSessionTransition(state('running'),{type:'terminal_transition',target,reviewNext:'needs_review'},{revision:'none'});
 expect(decision.kind).toBe('apply');
 expect(decision.next.status).toBe(target);
 expect(decision.next.termination).toBe('recorded');
 }
 for(const command of ['register','execution_registration','running_transition','terminal_transition','node_disconnect_cleanup','startup_reconcile_missing'] as const){
 for(const reviewNext of ['not_required','needs_review','acknowledged'] as const){
 const from=command==='register'?state('none'):state('running');
 const facts=command==='terminal_transition'?{revision:'none' as const}
 :command==='execution_registration'||command==='running_transition'?{resume:'fresh' as const,worktreeReady:true}
 :command==='node_disconnect_cleanup'?{nodeOwns:true}
 :command==='startup_reconcile_missing'?{targetMatches:true,inRunningList:false}
 :{};
 const decision=decideSessionTransition(from,{type:command,reviewNext,target:'completed'},facts);
 if(decision.kind!=='apply')continue;
 expect(decision.next.review,`${command} ${reviewNext}`).toBe(reviewNext);
 }
 }
 for(const status of ['none','initializing','running','completed','error','interrupted'] as const){
 const decision=decideSessionTransition(state(status),{type:'session_update_status'},{});
 if(decision.kind==='apply')expect(decision.next.status).toBe('running');
 }
});

it('keeps a non-applying verdict from moving the stored state',()=>{
 for(const row of sessionDecisionTable()){
 if(row.decision.kind==='apply')continue;
 expect(row.decision.next,`${row.command.type} ${JSON.stringify(row.state)}`).toEqual(row.state);
 }
});

it('pins every promise and its known hole',()=>{
 const results=checkSessionPromises();
 expect(results.map(result=>[result.id,result.violations])).toEqual([
 ['terminal_revision_monotonic',0],
 ['interrupted_accepts_recorded_terminal',0],
 ['cleanup_only_active',0],
 ['running_requires_worktree',0],
 ['terminal_to_running_only_resume',4],
 ['active_delete_needs_stop',0],
 ['limit_resume_chain',0],
 ]);
 const hole=results.find(result=>result.id==='terminal_to_running_only_resume')!;
 expect(hole.examples).toHaveLength(3);
 expect(hole.knownHole).toContain('session_update');
});

function probeRow(
 command: SessionDecisionCommand,
 value: SessionStateValue,
 facts: FiniteFacts,
 kind: SessionDecision['kind']='apply',
 next: SessionStateValue=value,
): SessionDecisionRow{
 return {
 state:value,
 command:SESSION_TABLE_COMMAND[command],
 facts,
 decision:{kind,next,reason:'probe',actions:[]},
 };
}

it('detects one injected defect per promise',()=>{
 const probes: Record<string,SessionDecisionRow>={
 terminal_revision_monotonic:probeRow('terminal_transition',state('completed','recorded'),{revision:'equal'}),
 interrupted_accepts_recorded_terminal:probeRow('terminal_transition',state('interrupted'),{revision:'none'},'reject'),
 cleanup_only_active:probeRow('node_disconnect_cleanup',state('interrupted','recorded'),{nodeOwns:true}),
 running_requires_worktree:probeRow('execution_registration',state('running'),{resume:'fresh',worktreeReady:false}),
 terminal_to_running_only_resume:probeRow('session_update_status',state('completed','recorded'),{},'apply',state('running')),
 active_delete_needs_stop:probeRow('delete',state('running'),{path:'timeout'}),
 limit_resume_chain:probeRow('resume_dispatch',state('error','recorded'),{chainContinued:false}),
 };
 for(const promise of SESSION_PROMISES){
 const probe=probes[promise.id];
 expect(probe,`${promise.id} 탐침이 없다`).toBeDefined();
 if(!probe)throw new Error(`${promise.id} 탐침이 없다`);
 expect(promise.breaks(probe),`${promise.id} 위반을 못 잡는다`).toBe(true);
 }
});

it('matches the delete product function for every table cell',async()=>{
 const codes: Record<string,string>={
 session_not_found:'SESSION_NOT_FOUND',
 node_rejected:'SESSION_DELETE_REJECTED',
 requires_stop:'SESSION_DELETE_REQUIRES_STOP',
 node_connecting:'SESSION_DELETE_NODE_CONNECTING',
 };
 for(const row of sessionDecisionTable().filter(candidate=>candidate.command.type==='delete')){
 const target=row.state.status==='none'?null:{nodeId:'n1',status:row.state.status};
 const transport={
 isNodeConnected:()=>row.facts.path!=='unavailable',
 sendDeleteCommand:async()=>{
 if(row.facts.path==='timeout')throw new PendingNodeCommandTimeoutError({commandType:'delete_session',requestId:'request-1',timeoutMs:1});
 if(row.facts.path==='rejected')return {status:'error'};
 if(row.facts.path==='declined')return {deleted:false};
 return {deleted:true};
 },
 };
 const deleted:string[]=[];
 let outcome:string|undefined;
 let error:unknown;
 try{
 outcome=await deleteSessionWithNode({
 sessionId:'session-1',target,transport,timeoutMs:1,
 deleteDirectly:async(id)=>{deleted.push(id);},
 }) as string;
 }catch(caught){error=caught;}
 const label=`${JSON.stringify(row.state)} ${row.facts.path}`;
 if(row.decision.kind==='apply'){
 expect(error,label).toBeUndefined();
 expect(outcome,label).toBe('deleted');
 expect(deleted,label).toEqual(row.facts.path==='deleted'?[]:['session-1']);
 }else if(row.decision.kind==='noop'){
 expect(error,label).toBeUndefined();
 expect(outcome,label).toBe('accepted');
 expect(deleted,label).toEqual([]);
 }else{
 expect(error,label).toBeInstanceOf(SessionDeleteError);
 expect((error as SessionDeleteError).code,label).toBe(codes[row.decision.reason]);
 expect(deleted,label).toEqual([]);
 }
 }
});

it('matches the resume dispatch product function for every table cell',()=>{
 for(const row of sessionDecisionTable().filter(candidate=>candidate.command.type==='resume_dispatch')){
 const termination=row.facts.termination;
 const session=row.state.status==='none'?null:{
 status:row.state.status,
 terminationReason:termination==='other'?'killed':'limit_hit',
 terminalEventId:termination==='limit_recorded'?5:termination==='limit_missing_revision'?null:5,
 };
 const decision=decideResumeDispatch({
 originalTerminalEventId:row.facts.originalRevision===true?5:null,
 session,
 continuousLimitWindow:row.facts.chainContinued===true,
 localTaskBusy:row.facts.localTaskBusy===true,
 });
 const label=`${JSON.stringify(row.state)} ${JSON.stringify(row.facts)}`;
 if(row.decision.kind==='apply'){
 expect(decision.decision,label).toBe('fire');
 }else if(row.decision.kind==='noop'){
 expect(decision.decision,label).toBe('defer');
 expect(decision.reason,label).toBe('local_task_busy');
 }else{
 expect(decision.decision,label).toBe('close');
 expect(decision.reason,label).toBe(row.decision.reason);
 }
 }
});

it('accepts every command payload as an event without a missing transition',()=>{
 for(const command of SESSION_COMMANDS){
 const payloads:SessionCommand[]=[SESSION_TABLE_COMMAND[command]];
 if(command==='terminal_transition')for(const target of ['completed','error','interrupted'] as const)payloads.push({...payloads[0]!,target});
 payloads.push({...payloads[0]!,reviewNext:'needs_review'});
 for(const payload of payloads)for(const value of tableStates){
 expect(()=>decideSessionTransition(value,payload,{})).not.toThrow();
 }
 }
});
