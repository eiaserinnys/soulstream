import { afterAll,beforeAll,expect,it } from 'vitest';
import {
 captureNodeStartupTargets,
 reconcileNodeStartup,
} from '../src/control_plane/repositories/node_startup_reconciliation.js';
import { SessionMutationRepository } from '../src/control_plane/repositories/session_mutation_repository.js';
import {
 EventIngressRepository,
 type EventIngressSql,
} from '../src/node/event_ingress_repository.js';
import type {
 EventAppendBatch,
 EventIngressEnvelope,
} from '../src/node/event_ingress_types.js';
import {
 classifySessionRow,
 isSessionStartupTarget,
 SESSION_SQL_PREDICATES,
 type SessionClassificationRow,
 type SessionClassifierName,
} from '../src/session/state/session_state_classifiers.js';
import type { FiniteFacts } from '../src/session/state/session_decision_facts.js';
import {
 sessionDecisionTable,
 type SessionDecisionRow,
} from '../src/session/state/session_decision_table.js';
import {
 rowToStateValue,
 stateValueToColumns,
 type SessionStateValue,
} from '../src/session/state/session_state_value.js';
import { repositoryModelCatalog } from './helpers/model_catalog.js';
import {
 createFullSchemaPostgresHarness,
 type FullSchemaPostgresHarness,
} from './board_yjs_postgres_harness.js';

let h: FullSchemaPostgresHarness;

beforeAll(async()=>{h=await createFullSchemaPostgresHarness();},120000);
afterAll(async()=>{await h?.cleanup();});

const rows=sessionDecisionTable();

async function reset():Promise<void>{
 await h.sql.unsafe('TRUNCATE TABLE sessions, worktrees CASCADE');
}

async function seed(sessionId:string,options:{
 state:SessionStateValue;
 terminationEventId?:number|null;
 reviewRequired?:boolean;
 worktreeId?:string|null;
 executionRegistrationId?:string|null;
 nodeId?:string;
 updatedAt?:Date;
}):Promise<void>{
 if(options.state.status==='none')return;
 const columns=stateValueToColumns(options.state);
 await h.sql`
 INSERT INTO sessions (
 session_id,node_id,session_type,status,termination_event_id,termination_reason,
 review_required,review_state,execution_registration_id,worktree_id,updated_at
 ) VALUES (
 ${sessionId},${options.nodeId??'n1'},'worker',${columns.status},
 ${options.terminationEventId===undefined?columns.termination_event_id:options.terminationEventId},
 ${options.state.termination==='recorded'?'completed':null},
 ${options.reviewRequired??false},${columns.review_state},
 ${options.executionRegistrationId??null},${options.worktreeId??null},
 ${options.updatedAt??new Date()}
 )`;
}

async function insertWorktree(
 id:string,
 options:{state:'ready'|'removing'|'removed';setupRequired?:boolean},
):Promise<void>{
 await h.sql`
 INSERT INTO worktrees (
 id,node_id,repo_id,canonical_path,branch,created_from_sha,
 created_by_session_id,state,setup_required,worktree_identity
 ) VALUES (
 ${id},'n1','repo',${`/tmp/${id}`},${`branch-${id}`},'sha',
 'creator',${options.state},${options.setupRequired??false},${`identity-${id}`}
 )`;
}

/** 실행 등록과 실행 중 전환의 워크트리 사실대로 DB를 세운다. */
async function seedWorktreeGate(facts:FiniteFacts):Promise<string|null>{
 switch(facts.worktree){
 case 'none':return null;
 case 'ready':
 await insertWorktree('worktree-1',{state:'ready'});
 if(facts.worktreeBusy===true){
 await seed('session-peer',{
 state:{status:'running',termination:'none',review:'not_required',reservation:'none',verdict:'ready'},
 worktreeId:'worktree-1',
 });
 }
 return 'worktree-1';
 case 'not_ready':
 await insertWorktree('worktree-1',{state:'removing'});
 return 'worktree-1';
 case 'setup_required':
 await insertWorktree('worktree-1',{state:'ready',setupRequired:true});
 return 'worktree-1';
 default:return null;
 }
}

function expectedValue(row:SessionDecisionRow):SessionStateValue{
 return row.decision.kind==='apply'?row.decision.next:row.state;
}

async function storedValue(sessionId:string):Promise<SessionStateValue>{
 const [stored]=await h.sql<Array<Record<string,unknown>>>`
 SELECT status,termination_event_id,review_state
 FROM sessions WHERE session_id=${sessionId}`;
 return rowToStateValue(stored??null);
}

function expectSameState(
 actual:SessionStateValue,
 expected:SessionStateValue,
 label:string,
):void{
 expect({
 status:actual.status,
 termination:actual.termination,
 review:actual.review,
 },label).toEqual({
 status:expected.status,
 termination:expected.termination,
 review:expected.review,
 });
}

function rowLabel(row:SessionDecisionRow):string{
 return `${JSON.stringify(row.state)} ${JSON.stringify(row.facts)}`;
}

function expectedTerminalEventId(row:SessionDecisionRow,existing:number|null):number|null{
 if(row.facts.resume==='terminal_match')return existing;
 if(row.facts.resume==='terminal_mismatch')return existing===null?11:existing+1;
 return null;
}

it('matches session_register for every registration cell',async()=>{
 const registrationRows=rows.filter(row=>row.command.type==='register');
 expect(registrationRows).toHaveLength(9);
 for(const row of registrationRows){
 await reset();
 await seed('session-1',{state:row.state});
 let raised=false;
 try{
 await h.sql`
 SELECT session_register_with_model_preset(
 'session-1','n1','agent-1',NULL,'worker',NULL,NULL,'initializing',
 NOW(),NOW(),NULL,TRUE,FALSE,'not_required',NULL,NULL,NULL,NULL
 )`;
 }catch{raised=true;}
 const label=rowLabel(row);
 expect(raised,label).toBe(row.decision.kind!=='apply');
 expectSameState(await storedValue('session-1'),expectedValue(row),label);
 }
},120000);

it('matches session_record_execution_registration for every cell',async()=>{
 const executionRows=rows.filter(row=>row.command.type==='execution_registration'&&row.facts.owner==='match');
 expect(executionRows).toHaveLength(111);
 for(const row of executionRows){
 await reset();
 const worktreeId=await seedWorktreeGate(row.facts);
 const existing=row.state.termination==='recorded'?10:null;
 await seed('session-1',{
 state:row.state,
 terminationEventId:existing,
 reviewRequired:true,
 worktreeId,
 });
 const label=rowLabel(row);
 let raised=false;
 let applied=false;
 try{
 const rowsOut=await h.sql<Array<{applied:boolean}>>`
 SELECT applied
 FROM session_record_execution_registration(
 'session-1','registration-1','command-1','needs_review',
 ${expectedTerminalEventId(row,existing)},${row.facts.resume!=='fresh'},NOW()
 )`;
 applied=rowsOut[0]?.applied===true;
 }catch{raised=true;}
 expect(raised,label).toBe(row.state.status==='none');
 expect(applied,label).toBe(row.decision.kind==='apply');
 expectSameState(await storedValue('session-1'),expectedValue(row),label);
 }
},120000);

it('matches session_apply_running_transition for every cell',async()=>{
 const runningRows=rows.filter(row=>row.command.type==='running_transition'&&row.facts.owner==='match'&&row.facts.adopt!==true);
 expect(runningRows).toHaveLength(111);
 for(const row of runningRows){
 await reset();
 const worktreeId=await seedWorktreeGate(row.facts);
 const existing=row.state.termination==='recorded'?10:null;
 await seed('session-1',{
 state:row.state,
 terminationEventId:existing,
 reviewRequired:true,
 worktreeId,
 });
 const rowsOut=await h.sql<Array<{applied:boolean}>>`
 SELECT applied
 FROM session_apply_running_transition(
 'session-1','needs_review',
 ${expectedTerminalEventId(row,existing)},${row.facts.resume!=='fresh'},NOW()
 )`;
 const applied=rowsOut[0]?.applied===true;
 const label=rowLabel(row);
 expect(applied,label).toBe(row.decision.kind==='apply');
 expectSameState(await storedValue('session-1'),expectedValue(row),label);
 }
},120000);

it('matches session_apply_terminal_transition for every revision cell',async()=>{
 const terminalRows=rows.filter(row=>row.command.type==='terminal_transition'&&row.facts.owner==='match');
 expect(terminalRows).toHaveLength(20);
 for(const row of terminalRows){
 await reset();
 const existing=row.state.termination==='recorded'
 ?row.facts.revision==='greater'?20:10
 :null;
 const eventId=row.facts.eventId==='non_positive'
 ?0
 :row.facts.revision==='greater'||row.facts.revision==='equal'?10:20;
 await seed('session-1',{
 state:row.state,
 terminationEventId:existing,
 reviewRequired:true,
 });
 const label=rowLabel(row);
 let raised=false;
 let applied=false;
 try{
 const rowsOut=await h.sql<Array<{applied:boolean}>>`
 SELECT applied
 FROM session_apply_terminal_transition(
 'session-1','completed','completed',NULL,'needs_review','text',${eventId},NOW()
 )`;
 applied=rowsOut[0]?.applied===true;
 }catch{raised=true;}
 expect(raised,label).toBe(row.facts.eventId==='non_positive');
 expect(applied,label).toBe(row.decision.kind==='apply');
 expectSameState(await storedValue('session-1'),expectedValue(row),label);
 }
},120000);

it('matches session_acknowledge_review for every review cell',async()=>{
 const reviewRows=rows.filter(row=>row.command.type==='acknowledge_review');
 expect(reviewRows).toHaveLength(14);
 const outcomes:Record<string,string>={
 not_found:'session_missing',
 not_required:'review_not_required',
 already_acknowledged:'already_acknowledged',
 not_pending:'review_not_pending',
 };
 for(const row of reviewRows){
 await reset();
 await seed('session-1',{state:row.state,reviewRequired:row.facts.reviewRequired===true});
 const rowsOut=await h.sql<Array<{outcome:string}>>`
 SELECT session_acknowledge_review('session-1',NOW()) AS outcome`;
 const outcome=String(rowsOut[0]?.outcome);
 const label=rowLabel(row);
 if(row.decision.kind==='apply'){
 expect(outcome,label).toBe('acknowledged');
 }else{
 expect(outcome,label).toBe(
 Object.entries(outcomes).find(([,reason])=>reason===row.decision.reason)?.[0],
 );
 }
 expectSameState(await storedValue('session-1'),expectedValue(row),label);
 }
},120000);

it('matches session_update for every table cell',async()=>{
 const updateRows=rows.filter(row=>row.command.type==='session_update_status');
 expect(updateRows).toHaveLength(9);
 for(const row of updateRows){
 await reset();
 await seed('session-1',{state:row.state,reviewRequired:true});
 await h.sql`
 SELECT session_update('session-1',${h.sql.array(['status'])},${h.sql.array(['running'])},NOW())`;
 const label=rowLabel(row);
 expect(row.decision.kind,label).toBe(row.state.status==='none'?'noop':'apply');
 expectSameState(await storedValue('session-1'),expectedValue(row),label);
 }
},120000);

it('matches node disconnect cleanup for every table cell',async()=>{
 const repository=new SessionMutationRepository(h.sql);
 for(const row of rows.filter(candidate=>candidate.command.type==='node_disconnect_cleanup')){
 await reset();
 await seed('session-1',{
 state:row.state,
 nodeId:row.facts.nodeOwns===true?'n1':'n2',
 reviewRequired:true,
 });
 const result=await repository.reconcileNodeDisconnected('n1',new Date(),'node_disconnect');
 const touched=result.updates.some(update=>update.sessionId==='session-1');
 const label=rowLabel(row);
 expect(touched,label).toBe(row.decision.kind==='apply');
 expectSameState(await storedValue('session-1'),expectedValue(row),label);
 }
},120000);

it('matches startup reconciliation for missing sessions',async()=>{
 const missingRows=rows.filter(candidate=>candidate.command.type==='startup_reconcile_missing');
 expect(missingRows).toHaveLength(26);
 for(const row of missingRows){
 await reset();
 // 같은 제품 호출이 되살림 명령도 수행하므로, 사라진 세션 명령만 보이도록
 // 되살림이 닿을 수 있는 한 줄은 준비 안 된 워크트리로 막아 둔다.
 const restoreBlocked=row.state.status==='interrupted'
 && row.state.termination==='none'
 && row.facts.inRunningList===true;
 if(restoreBlocked)await insertWorktree('worktree-1',{state:'removing'});
 const updatedAt=new Date(Date.now()-3_600_000);
 await seed('session-1',{
 state:row.state,
 worktreeId:restoreBlocked?'worktree-1':null,
 updatedAt,
 reviewRequired:true,
 });
 const targets=row.facts.targetMatches===true
 ?await captureNodeStartupTargets(h.sql,'n1')
 :[];
 const runningSessionIds=row.facts.inRunningList===true?['session-1']:[];
 const result=await reconcileNodeStartup(h.sql,'n1',runningSessionIds,new Date(),targets);
 const touched=result.updates.some(update=>
 update.sessionId==='session-1'&&update.status==='interrupted');
 const label=rowLabel(row);
 expect(touched,label).toBe(row.decision.kind==='apply');
 expectSameState(await storedValue('session-1'),expectedValue(row),label);
 }
},120000);

it('matches startup reconciliation for restored sessions',async()=>{
 const restoreRows=rows.filter(candidate=>candidate.command.type==='startup_reconcile_restore');
 expect(restoreRows).toHaveLength(36);
 for(const row of restoreRows){
 await reset();
 const blocked=row.state.status!=='none'&&row.facts.worktreeReady===false;
 if(blocked)await insertWorktree('worktree-1',{state:'removing'});
 await seed('session-1',{
 state:row.state,
 terminationEventId:row.state.termination==='recorded'?10:null,
 worktreeId:blocked?'worktree-1':null,
 updatedAt:new Date(Date.now()-3_600_000),
 reviewRequired:true,
 });
 const runningSessionIds=row.facts.inRunningList===true?['session-1']:[];
 const result=await reconcileNodeStartup(h.sql,'n1',runningSessionIds,new Date(),[]);
 const touched=result.updates.some(update=>
 update.sessionId==='session-1'&&update.status==='running');
 const label=rowLabel(row);
 expect(touched,label).toBe(row.decision.kind==='apply');
 expectSameState(await storedValue('session-1'),expectedValue(row),label);
 }
},120000);

const STREAM_ID='018f47b7-c6de-7d64-9c8d-0b62cbbb2e10';

it('matches the event ingress stale registration rejection and current acceptance',async()=>{
 await reset();
 await seed('session-1',{
 state:{status:'running',termination:'none',review:'acknowledged',reservation:'none',verdict:'ready'},
 executionRegistrationId:'registration-current',
 });
 const repository=new EventIngressRepository(
 {resolveSql:async()=>h.sql as unknown as EventIngressSql},
 undefined,
 undefined,
 {modelCatalog:repositoryModelCatalog()},
 );
 function envelope(sessionId:string,registrationId:string|null,sourceSeq:number,hash:string):EventIngressEnvelope{
 return {
 stream_id:STREAM_ID,
 source_seq:sourceSeq,
 session_id:sessionId,
 registration_id:registrationId,
 event_type:'assistant_message',
 payload:{type:'assistant_message',content:'hi'},
 searchable_text:'hi',
 created_at:new Date().toISOString(),
 semantic_dedupe_key:null,
 session_effect:null,
 payload_hash:hash,
 };
 }
 function batch(...events:EventIngressEnvelope[]):EventAppendBatch{
 return {
 type:'event_append_batch',
 protocol_version:1,
 stream_id:STREAM_ID,
 first_seq:events[0]?.source_seq??1,
 events,
 };
 }
 const stale=await repository.commitBatch('n1',batch(
 envelope('session-1','registration-stale',1,'a'.repeat(64)),
 ));
 expect(stale[0]?.outcome).toBe('dead_lettered');
 if(stale[0]?.outcome==='dead_lettered'){
 expect(stale[0].deadLetter.code).toBe('STALE_REGISTRATION');
 }
 const mismatchRow=rows.find(candidate=>
 candidate.command.type==='stale_registration'
 && candidate.state.status==='running'
 && candidate.state.termination==='none'
 && candidate.state.review==='acknowledged'
 && candidate.facts.registration==='stale'
 )!;
 expectSameState(
 await storedValue('session-1'),
 expectedValue(mismatchRow),
 'stale_registration mismatch',
 );
 const current=await repository.commitBatch('n1',batch(
 envelope('session-1','registration-current',2,'b'.repeat(64)),
 ));
 expect(current[0]?.outcome).toBe('committed');
 const matchRow=rows.find(candidate=>
 candidate.command.type==='stale_registration'
 && candidate.state.status==='running'
 && candidate.state.termination==='none'
 && candidate.state.review==='acknowledged'
 && candidate.facts.registration==='matches'
 )!;
 expectSameState(
 await storedValue('session-1'),
 expectedValue(matchRow),
 'stale_registration matches',
 );
 await expect(repository.commitBatch('n1',batch(
 envelope('session-missing',null,3,'c'.repeat(64)),
 ))).rejects.toThrow(/does not exist/);
},120000);

it('classifies rows the same way in SQL and TypeScript',async()=>{
 await reset();
 const fixtures:Array<{id:string;row:SessionClassificationRow}>= [
 {id:'c1',row:{status:'running',termination_event_id:5,termination_reason:'limit_hit',review_state:'needs_review',execution_registration_id:null}},
 {id:'c2',row:{status:'initializing',termination_event_id:null,termination_reason:null,review_state:'not_required',execution_registration_id:null}},
 {id:'c3',row:{status:'initializing',termination_event_id:null,termination_reason:null,review_state:'not_required',execution_registration_id:'registration-1'}},
 {id:'c4',row:{status:'completed',termination_event_id:5,termination_reason:'completed',review_state:'needs_review',execution_registration_id:null}},
 {id:'c5',row:{status:'error',termination_event_id:5,termination_reason:'limit_hit',review_state:'needs_review',execution_registration_id:null}},
 {id:'c6',row:{status:'error',termination_event_id:null,termination_reason:'limit_hit',review_state:'not_required',execution_registration_id:null}},
 {id:'c7',row:{status:'interrupted',termination_event_id:null,termination_reason:'killed',review_state:'needs_review',execution_registration_id:null}},
 {id:'c8',row:{status:'interrupted',termination_event_id:7,termination_reason:'killed',review_state:'needs_review',execution_registration_id:null}},
 {id:'c9',row:{status:null,termination_event_id:null,termination_reason:null,review_state:'not_required',execution_registration_id:null}},
 ];
 for(const fixture of fixtures){
 await h.sql`
 INSERT INTO sessions (
 session_id,node_id,status,termination_event_id,termination_reason,
 review_state,execution_registration_id
 ) VALUES (
 ${fixture.id},'n1',${fixture.row.status},${fixture.row.termination_event_id??null},
 ${fixture.row.termination_reason??null},${fixture.row.review_state??'not_required'},
 ${fixture.row.execution_registration_id??null}
 )`;
 }
 for(const name of Object.keys(SESSION_SQL_PREDICATES) as SessionClassifierName[]){
 for(const fixture of fixtures){
 const rowsOut=await h.sql.unsafe(
 `SELECT COALESCE(${SESSION_SQL_PREDICATES[name]('s')}, FALSE) AS value FROM sessions s WHERE s.session_id = $1`,
 [fixture.id],
 ) as Array<{value:boolean}>;
 expect(rowsOut[0]?.value,`${name} ${fixture.id}`).toBe(classifySessionRow(name,fixture.row));
 }
 }
 const targets=await captureNodeStartupTargets(h.sql,'n1');
 expect(targets.map(target=>target.sessionId).sort()).toEqual(
 fixtures.filter(fixture=>isSessionStartupTarget(fixture.row)).map(fixture=>fixture.id).sort(),
 );
},120000);
