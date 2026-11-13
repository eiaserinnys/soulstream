import { afterAll,beforeAll,expect,it } from 'vitest';
import {
 captureNodeStartupTargets,
 reconcileNodeStartup,
} from '../src/control_plane/repositories/node_startup_reconciliation.js';
import { SessionMutationRepository } from '../src/control_plane/repositories/session_mutation_repository.js';
import {
 classifySessionRow,
 isSessionStartupTarget,
 SESSION_SQL_PREDICATES,
 type SessionClassificationRow,
 type SessionClassifierName,
} from '../src/session/state/session_state_classifiers.js';
import { sessionDecisionTable } from '../src/session/state/session_decision_table.js';
import type { SessionStateValue } from '../src/session/state/session_state_value.js';
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
 terminationReason?:string|null;
 reviewRequired?:boolean;
 worktreeId?:string|null;
 executionRegistrationId?:string|null;
 nodeId?:string;
 updatedAt?:Date;
}):Promise<void>{
 if(options.state.status==='none')return;
 await h.sql`
 INSERT INTO sessions (
 session_id,node_id,session_type,status,termination_event_id,termination_reason,
 review_required,review_state,execution_registration_id,worktree_id,updated_at
 ) VALUES (
 ${sessionId},${options.nodeId??'n1'},'worker',${options.state.status},
 ${options.terminationEventId??null},${options.terminationReason??null},
 ${options.reviewRequired??false},${options.state.review},
 ${options.executionRegistrationId??null},${options.worktreeId??null},
 ${options.updatedAt??new Date()}
 )`;
}

async function insertWorktree(id:string,state:'ready'|'removing'|'removed'):Promise<void>{
 await h.sql`
 INSERT INTO worktrees (
 id,node_id,repo_id,canonical_path,branch,created_from_sha,
 created_by_session_id,state,worktree_identity
 ) VALUES (
 ${id},'n1','repo',${`/tmp/${id}`},${`branch-${id}`},'sha',
 'creator',${state},${`identity-${id}`}
 )`;
}

function expectedTerminationId(
 row:(typeof rows)[number],
 match:number,
 mismatch:number,
):number|null{
 if(row.facts.resume==='terminal_match')return row.state.termination==='recorded'?match:null;
 if(row.facts.resume==='terminal_mismatch')return mismatch;
 return null;
}

it('matches session_register for every registration cell',async()=>{
 const registrationRows=rows.filter(row=>row.command.type==='register');
 expect(registrationRows).toHaveLength(7);
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
 if(row.decision.kind==='apply'){
 expect(raised,JSON.stringify(row.state)).toBe(false);
 const [stored]=await h.sql<Array<{status:string|null;review_state:string}>>`
 SELECT status,review_state FROM sessions WHERE session_id='session-1'`;
 expect(stored?.status,JSON.stringify(row.state)).toBe(row.decision.next.status);
 expect(stored?.review_state,JSON.stringify(row.state)).toBe(row.decision.next.review);
 }else{
 expect(raised,JSON.stringify(row.state)).toBe(true);
 }
 }
},120000);

it('matches session_record_execution_registration for every cell',async()=>{
 const executionRows=rows.filter(row=>row.command.type==='execution_registration');
 expect(executionRows).toHaveLength(42);
 for(const row of executionRows){
 await reset();
 const blocked=row.state.status!=='none'&&row.facts.worktreeReady===false;
 if(blocked)await insertWorktree('worktree-1','removing');
 await seed('session-1',{
 state:row.state,
 terminationEventId:row.state.termination==='recorded'?10:null,
 reviewRequired:true,
 worktreeId:blocked?'worktree-1':null,
 });
 if(row.state.status==='none'){
 let raised=false;
 try{
 await h.sql`
 SELECT session_record_execution_registration(
 'session-1','registration-1','command-1','needs_review',NULL,FALSE,NOW()
 )`;
 }catch{raised=true;}
 expect(raised,row.decision.reason).toBe(true);
 continue;
 }
 const rowsOut=await h.sql<Array<{
 applied:boolean;status:string|null;review_state:string;termination_event_id:number|null;
 }>>`
 SELECT applied,status,review_state,termination_event_id
 FROM session_record_execution_registration(
 'session-1','registration-1','command-1','needs_review',
 ${expectedTerminationId(row,10,11)},${row.facts.resume!=='fresh'},NOW()
 )`;
 const applied=rowsOut[0]?.applied===true;
 const label=`${JSON.stringify(row.state)} ${JSON.stringify(row.facts)}`;
 expect(applied,label).toBe(row.decision.kind==='apply');
 if(applied){
 expect(rowsOut[0]?.status,label).toBe('running');
 expect(rowsOut[0]?.review_state,label).toBe('needs_review');
 expect(rowsOut[0]?.termination_event_id,label).toBeNull();
 }
 }
},120000);

it('matches session_apply_running_transition for every cell',async()=>{
 const runningRows=rows.filter(row=>row.command.type==='running_transition');
 expect(runningRows).toHaveLength(42);
 for(const row of runningRows){
 await reset();
 const blocked=row.state.status!=='none'&&row.facts.worktreeReady===false;
 if(blocked)await insertWorktree('worktree-1','removing');
 await seed('session-1',{
 state:row.state,
 terminationEventId:row.state.termination==='recorded'?10:null,
 reviewRequired:true,
 worktreeId:blocked?'worktree-1':null,
 });
 const rowsOut=await h.sql<Array<{
 applied:boolean;status:string|null;review_state:string;
 }>>`
 SELECT applied,status,review_state
 FROM session_apply_running_transition(
 'session-1','needs_review',
 ${expectedTerminationId(row,10,11)},${row.facts.resume!=='fresh'},NOW()
 )`;
 const applied=rowsOut[0]?.applied===true;
 const label=`${JSON.stringify(row.state)} ${JSON.stringify(row.facts)}`;
 expect(applied,label).toBe(row.decision.kind==='apply');
 if(applied){
 expect(rowsOut[0]?.status,label).toBe('running');
 expect(rowsOut[0]?.review_state,label).toBe('needs_review');
 }
 }
},120000);

it('matches session_apply_terminal_transition for every revision cell',async()=>{
 const terminalRows=rows.filter(row=>row.command.type==='terminal_transition');
 expect(terminalRows).toHaveLength(13);
 for(const row of terminalRows){
 await reset();
 const existing=row.state.termination==='recorded'
 ?row.facts.revision==='greater'?20:10
 :null;
 const eventId=row.facts.revision==='greater'||row.facts.revision==='equal'?10:20;
 await seed('session-1',{
 state:row.state,
 terminationEventId:existing,
 reviewRequired:true,
 });
 const rowsOut=await h.sql<Array<{
 applied:boolean;status:string|null;termination_event_id:number|null;
 }>>`
 SELECT applied,status,termination_event_id
 FROM session_apply_terminal_transition(
 'session-1','completed','completed',NULL,'needs_review','text',${eventId},NOW()
 )`;
 const applied=rowsOut[0]?.applied===true;
 const label=`${JSON.stringify(row.state)} ${JSON.stringify(row.facts)}`;
 expect(applied,label).toBe(row.decision.kind==='apply');
 if(applied){
 expect(rowsOut[0]?.status,label).toBe('completed');
 expect(rowsOut[0]?.termination_event_id,label).toBe(eventId);
 }
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
 const label=`${JSON.stringify(row.state)} ${JSON.stringify(row.facts)}`;
 if(row.decision.kind==='apply'){
 expect(outcome,label).toBe('acknowledged');
 const [stored]=await h.sql<Array<{review_state:string}>>`
 SELECT review_state FROM sessions WHERE session_id='session-1'`;
 expect(stored?.review_state,label).toBe('acknowledged');
 }else{
 expect(outcome,label).toBe(Object.entries(outcomes).find(([,reason])=>reason===row.decision.reason)?.[0]);
 }
 }
},120000);

it('records the session_update terminal-to-running hole',async()=>{
 const updateRows=rows.filter(row=>row.command.type==='session_update_status');
 expect(updateRows).toHaveLength(7);
 for(const row of updateRows){
 await reset();
 await seed('session-1',{state:row.state,reviewRequired:true});
 if(row.state.status==='none'){
 expect(row.decision.kind,JSON.stringify(row.state)).toBe('noop');
 continue;
 }
 await h.sql`
 SELECT session_update('session-1',${h.sql.array(['status'])},${h.sql.array(['running'])},NOW())`;
 const [stored]=await h.sql<Array<{status:string}>>`
 SELECT status FROM sessions WHERE session_id='session-1'`;
 expect(row.decision.kind,JSON.stringify(row.state)).toBe('apply');
 expect(row.decision.next.status,JSON.stringify(row.state)).toBe('running');
 expect(stored?.status,JSON.stringify(row.state)).toBe('running');
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
 const label=`${JSON.stringify(row.state)} ${JSON.stringify(row.facts)}`;
 expect(touched,label).toBe(row.decision.kind==='apply');
 if(touched)expect(row.decision.next.status,label).toBe('interrupted');
 }
},120000);

it('matches startup reconciliation for missing sessions',async()=>{
 const missingRows=rows.filter(candidate=>candidate.command.type==='startup_reconcile_missing');
 expect(missingRows).toHaveLength(18);
 for(const row of missingRows){
 await reset();
 const updatedAt=new Date(Date.now()-3_600_000);
 await seed('session-1',{state:row.state,updatedAt,reviewRequired:true});
 const targets=row.facts.targetMatches===true
 ?await captureNodeStartupTargets(h.sql,'n1')
 :[];
 const runningSessionIds=row.facts.inRunningList===true?['session-1']:[];
 const result=await reconcileNodeStartup(h.sql,'n1',runningSessionIds,new Date(),targets);
 const touched=result.updates.some(update=>
 update.sessionId==='session-1'&&update.status==='interrupted');
 const label=`${JSON.stringify(row.state)} ${JSON.stringify(row.facts)}`;
 expect(touched,label).toBe(row.decision.kind==='apply');
 }
},120000);

it('matches startup reconciliation for restored sessions',async()=>{
 const restoreRows=rows.filter(candidate=>candidate.command.type==='startup_reconcile_restore');
 expect(restoreRows).toHaveLength(28);
 for(const row of restoreRows){
 await reset();
 const blocked=row.state.status!=='none'&&row.facts.worktreeReady===false;
 if(blocked)await insertWorktree('worktree-1','removing');
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
 const label=`${JSON.stringify(row.state)} ${JSON.stringify(row.facts)}`;
 expect(touched,label).toBe(row.decision.kind==='apply');
 }
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
