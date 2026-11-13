import { afterAll,beforeAll,expect,it } from 'vitest';
import { SessionMutationRepository } from '../src/control_plane/repositories/session_mutation_repository.js';
import {
 EventIngressRepository,
 type EventIngressSql,
} from '../src/node/event_ingress_repository.js';
import { applyEventSessionEffect } from '../src/node/event_session_effect_applier.js';
import type {
 EventAppendBatch,
 EventIngressEnvelope,
 EventIngressResult,
 EventSessionEffect,
 EventSessionEffectApplication,
} from '../src/node/event_ingress_types.js';
import {
 SESSION_REJECTION_REASON_WIRE,
} from '../src/session/state/session_decision_labels.js';
import type {
 FiniteFacts,
 SessionDecisionCommand,
} from '../src/session/state/session_decision_facts.js';
import {
 sessionDecisionTable,
 type SessionDecisionRow,
} from '../src/session/state/session_decision_table.js';
import {
 rowToStateValue,
 stateValueToColumns,
 type SessionStateValue,
} from '../src/session/state/session_state_value.js';
import {
 sessionCanonicalProjection,
 type SessionGateRow,
} from '../src/node/event_session_gate.js';
import { repositoryModelCatalog } from './helpers/model_catalog.js';
import {
 createFullSchemaPostgresHarness,
 type FullSchemaPostgresHarness,
} from './board_yjs_postgres_harness.js';

let h: FullSchemaPostgresHarness;

beforeAll(async()=>{h=await createFullSchemaPostgresHarness();},120000);
afterAll(async()=>{await h?.cleanup();});

const STREAM_ID='018f47b7-c6de-7d64-9c8d-0b62cbbb2e10';
const SESSION_ID='session-1';
const NOW='2026-11-13T00:00:00.000Z';
const rows=sessionDecisionTable();

function stateOf(
 status:SessionStateValue['status'],
 termination:SessionStateValue['termination']='none',
 review:SessionStateValue['review']='not_required',
):SessionStateValue{
 return {status,termination,review,reservation:'none',verdict:'ready'};
}

const RUNNING_ACK=stateOf('running','none','acknowledged');
const RUNNING_NEEDS_REVIEW=stateOf('running','none','needs_review');
const INTERRUPTED_NEEDS_REVIEW=stateOf('interrupted','none','needs_review');

function repository():EventIngressRepository{
 return new EventIngressRepository(
  {resolveSql:async()=>h.sql as unknown as EventIngressSql},
  applyEventSessionEffect,
  undefined,
  {modelCatalog:repositoryModelCatalog()},
 );
}

async function reset():Promise<void>{
 await h.sql.unsafe('TRUNCATE TABLE sessions, worktrees CASCADE');
}

async function insertSession(options:{
 sessionId:string;
 state:SessionStateValue;
 nodeId:string|null;
 terminationEventId?:number|null;
 reviewRequired?:boolean;
 worktreeId?:string|null;
 lastEventId?:number|null;
 executionRegistrationId?:string|null;
 executionCommandId?:string|null;
 updatedAt?:Date;
}):Promise<void>{
 if(options.state.status==='none')return;
 const columns=stateValueToColumns(options.state);
 await h.sql`
 INSERT INTO sessions (
 session_id,node_id,session_type,status,termination_event_id,
 termination_reason,review_required,review_state,worktree_id,
 last_event_id,execution_registration_id,execution_command_id,updated_at
 ) VALUES (
 ${options.sessionId},${options.nodeId},'worker',${columns.status},
 ${options.terminationEventId===undefined?columns.termination_event_id:options.terminationEventId},
 ${options.state.termination==='recorded'?'completed':null},
 ${options.reviewRequired??false},${columns.review_state},
 ${options.worktreeId??null},${options.lastEventId??null},
 ${options.executionRegistrationId??null},${options.executionCommandId??null},
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
   await insertSession({
    sessionId:'session-peer',
    state:stateOf('running'),
    nodeId:'n1',
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

/**
 * 사건 번호를 2로 고정하기 위해 1번 사건을 미리 심는다. event_append는 세션별
 * MAX(id)+1을 쓰므로 종료 전환의 리비전 사실을 1/2/3으로 정확히 만들 수 있다.
 */
async function insertDummyEvent():Promise<void>{
 await h.sql`
 INSERT INTO events (id,session_id,event_type,payload,searchable_text,created_at)
 VALUES (1,${SESSION_ID},'system_message','{}'::jsonb,'',NOW())`;
}

async function lockedRow():Promise<SessionGateRow>{
 const [row]=await h.sql<SessionGateRow[]>`
 SELECT node_id,status,termination_reason,termination_detail,review_state,
 last_assistant_text,termination_event_id,last_event_id,updated_at,
 worktree_id,execution_registration_id,execution_command_id
 FROM sessions WHERE session_id=${SESSION_ID}`;
 if(!row)throw new Error('seeded session row is missing');
 return row;
}

async function storedValue(sessionId:string):Promise<SessionStateValue>{
 const [row]=await h.sql<Array<Record<string,unknown>>>`
 SELECT status,termination_event_id,review_state
 FROM sessions WHERE session_id=${sessionId}`;
 return rowToStateValue(row??null);
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
 return `${row.command.type} ${JSON.stringify(row.state)} ${JSON.stringify(row.facts)}`;
}

function hashFor(seq:number):string{
 return seq.toString(16).padStart(64,'0');
}

function batch(envelope:EventIngressEnvelope):EventAppendBatch{
 return {
  type:'event_append_batch',
  protocol_version:1,
  stream_id:STREAM_ID,
  first_seq:envelope.source_seq,
  events:[envelope],
 };
}

function committedApplication(
 result:EventIngressResult|undefined,
):EventSessionEffectApplication{
 if(result?.outcome!=='committed'||!result.sessionEffectApplication){
  throw new Error('expected a committed event with a session effect application');
 }
 return result.sessionEffectApplication;
}

/** 종료 전환의 리비전 사실을 사건 번호 2 기준의 저장 값으로 옮긴다. */
function existingTerminationEventId(row:SessionDecisionRow):number|null{
 if(row.command.type==='terminal_transition'){
  switch(row.facts.revision){
  case 'none':return null;
  case 'less':return 1;
  case 'equal':return 2;
  case 'greater':return 3;
  default:return null;
  }
 }
 return row.state.termination==='recorded'?10:null;
}

/** 명령 사실에 맞는 종료 재개 기대 번호. 없으면 새 실행이다. */
function expectedTerminalEventId(
 row:SessionDecisionRow,
 existing:number|null,
):number|null|undefined{
 if(row.facts.resume==='terminal_match')return existing;
 if(row.facts.resume==='terminal_mismatch')return existing===null?11:existing+1;
 return undefined;
}

function reviewNext(row:SessionDecisionRow):'not_required'|'needs_review'|'acknowledged'{
 const value=row.command.reviewNext;
 if(!value)throw new Error(`table command has no reviewNext: ${row.command.type}`);
 return value;
}

function effectFor(
 row:SessionDecisionRow,
 existing:number|null,
):EventSessionEffect{
 const expected=expectedTerminalEventId(row,existing);
 if(row.command.type==='running_transition'){
  return {
   kind:'running_transition',
   review_state:reviewNext(row),
   ...(expected===undefined?{}:{expected_terminal_event_id:expected}),
   updated_at:NOW,
  };
 }
 if(row.command.type==='execution_registration'){
  return {
   kind:'execution_registration',
   registration_id:'registration-1',
   execution_command_id:'command-1',
   review_state:reviewNext(row),
   ...(expected===undefined?{}:{expected_terminal_event_id:expected}),
   updated_at:NOW,
  };
 }
 const target=row.command.target;
 if(!target)throw new Error(`terminal command has no target: ${row.command.type}`);
 return {
  kind:'terminal_transition',
  status:target,
  termination_reason:target,
  termination_detail:null,
  review_state:reviewNext(row),
  last_assistant_text:null,
  updated_at:NOW,
 };
}

function envelopeFor(row:SessionDecisionRow,options:{
 seq:number;
 adoptAttempt?:string;
 existing:number|null;
}):EventIngressEnvelope{
 const adopt=options.adoptAttempt!==undefined;
 return {
  stream_id:STREAM_ID,
  source_seq:options.seq,
  session_id:SESSION_ID,
  event_type:adopt?'metadata':'assistant_message',
  payload:adopt
   ?{
    type:'metadata',
    metadata_type:'session_status_transition',
    value:{transition_id:`adopt:command-1:${options.adoptAttempt}`},
   }
   :{type:'assistant_message',content:'hi'},
  searchable_text:adopt?null:'hi',
  created_at:NOW,
  semantic_dedupe_key:null,
  session_effect:effectFor(row,options.existing),
  payload_hash:hashFor(options.seq),
 };
}

function adoptEnvelope(seq:number,attempt:string):EventIngressEnvelope{
 return {
  stream_id:STREAM_ID,
  source_seq:seq,
  session_id:SESSION_ID,
  event_type:'metadata',
  payload:{
   type:'metadata',
   metadata_type:'session_status_transition',
   value:{transition_id:`adopt:command-1:${attempt}`},
  },
  searchable_text:null,
  created_at:NOW,
  semantic_dedupe_key:null,
  session_effect:{
   kind:'running_transition',
   review_state:'needs_review',
   updated_at:NOW,
  },
  payload_hash:hashFor(seq),
 };
}

function ownerEnvelope(
 command:SessionDecisionCommand,
 seq:number,
):EventIngressEnvelope{
 const effect:EventSessionEffect=command==='terminal_transition'
  ?{
   kind:'terminal_transition',
   status:'completed',
   termination_reason:'completed',
   termination_detail:null,
   review_state:'needs_review',
   last_assistant_text:null,
   updated_at:NOW,
  }
  :command==='execution_registration'
   ?{
    kind:'execution_registration',
    registration_id:'registration-1',
    execution_command_id:'command-1',
    review_state:'needs_review',
    updated_at:NOW,
   }
   :{kind:'running_transition',review_state:'needs_review',updated_at:NOW};
 return {
  stream_id:STREAM_ID,
  source_seq:seq,
  session_id:SESSION_ID,
  event_type:'assistant_message',
  payload:{type:'assistant_message',content:'hi'},
  searchable_text:'hi',
  created_at:NOW,
  semantic_dedupe_key:null,
  session_effect:effect,
  payload_hash:hashFor(seq),
 };
}

function ownerFacts(
 command:SessionDecisionCommand,
 owner:'match'|'mismatch',
):FiniteFacts{
 if(command==='terminal_transition'){
  return {revision:'none',eventId:'positive',owner};
 }
 if(command==='execution_registration'){
  return {resume:'fresh',worktree:'none',worktreeBusy:false,owner};
 }
 return {resume:'fresh',worktree:'none',worktreeBusy:false,owner,adopt:false};
}

function tableRow(
 command:SessionDecisionCommand,
 value:SessionStateValue,
 facts:FiniteFacts,
):SessionDecisionRow{
 const found=rows.find((row)=>
  row.command.type===command
  && row.state.status===value.status
  && row.state.termination===value.termination
  && row.state.review===value.review
  && Object.entries(facts).every(([key,fact])=>row.facts[key]===fact));
 if(!found){
  throw new Error(
   `결정표에 없는 칸: ${command} ${JSON.stringify(value)} ${JSON.stringify(facts)}`,
  );
 }
 return found;
}

/** 소유 노드가 다른 대표 줄은 상태 값마다 하나뿐이다. */
function ownerMismatchRow(
 command:SessionDecisionCommand,
 value:SessionStateValue,
):SessionDecisionRow{
 const found=rows.find((row)=>
  row.command.type===command
  && row.state.status===value.status
  && row.state.termination===value.termination
  && row.state.review===value.review
  && row.facts.owner==='mismatch');
 if(!found){
  throw new Error(
   `결정표에 없는 소유 노드 칸: ${command} ${JSON.stringify(value)}`,
  );
 }
 return found;
}

function wireReason(row:SessionDecisionRow):string|undefined{
 return SESSION_REJECTION_REASON_WIRE[row.decision.reason]??undefined;
}

async function seedRow(
 row:SessionDecisionRow,
 index:number,
):Promise<SessionGateRow|null>{
 await reset();
 if(row.state.status==='none')return null;
 // 소유 노드 match는 NULL과 같은 노드 두 꼴을 번갈아 심는다.
 const nodeId=row.facts.owner==='mismatch'?'n2':index%2===0?'n1':null;
 const existing=existingTerminationEventId(row);
 const worktreeId=row.command.type==='terminal_transition'
  ?null
  :await seedWorktreeGate(row.facts);
 await insertSession({
  sessionId:SESSION_ID,
  state:row.state,
  nodeId,
  terminationEventId:existing,
  reviewRequired:row.state.review==='needs_review',
  worktreeId,
  lastEventId:1,
 });
 await insertDummyEvent();
 return await lockedRow();
}

async function expectRowMatchesDecision(
 row:SessionDecisionRow,
 index:number,
 ingress:EventIngressRepository,
):Promise<void>{
 const label=rowLabel(row);
 const locked=await seedRow(row,index);
 const envelope=envelopeFor(row,{
  seq:1,
  existing:existingTerminationEventId(row),
  ...(row.facts.adopt===true
   ?{adoptAttempt:`00000000-0000-4000-8000-${String(index).padStart(12,'0')}`}
   :{}),
 });
 if(locked===null){
  // 세션 줄이 없으면 지금처럼 예외다(ACK로 싣지 않는다).
  await expect(ingress.commitBatch('n1',batch(envelope)),label)
   .rejects.toThrow(/does not exist/);
  return;
 }
 const result=await ingress.commitBatch('n1',batch(envelope));
 expect(result[0]?.outcome,label).toBe('committed');
 const application=committedApplication(result[0]);
 const expectedApplied=row.decision.kind==='apply';
 expect(application.applied,label).toBe(expectedApplied);
 if(expectedApplied){
  expect(application.canonicalSession,label).not.toBeNull();
  expectSameState(await storedValue(SESSION_ID),row.decision.next,label);
  return;
 }
 expect(application.rejectionReason,label).toBe(wireReason(row));
 expect(application.canonicalSession,label)
  .toEqual(sessionCanonicalProjection(locked));
 expectSameState(await storedValue(SESSION_ID),row.state,label);
}

it('matches every execution registration row through commitBatch',async()=>{
 const commandRows=rows.filter(row=>row.command.type==='execution_registration');
 expect(commandRows).toHaveLength(120);
 const ingress=repository();
 for(const [index,row] of commandRows.entries()){
  await expectRowMatchesDecision(row,index,ingress);
 }
},300000);

it('matches every running transition row through commitBatch',async()=>{
 const commandRows=rows.filter(row=>row.command.type==='running_transition');
 expect(commandRows).toHaveLength(157);
 const ingress=repository();
 for(const [index,row] of commandRows.entries()){
  await expectRowMatchesDecision(row,index,ingress);
 }
},300000);

it('matches every terminal transition row through commitBatch',async()=>{
 const commandRows=rows.filter(row=>row.command.type==='terminal_transition');
 expect(commandRows).toHaveLength(29);
 const ingress=repository();
 for(const [index,row] of commandRows.entries()){
  await expectRowMatchesDecision(row,index,ingress);
 }
},300000);

it('applies a new adoption attempt after the worktree occupancy is released',async()=>{
 await reset();
 await insertWorktree('worktree-1',{state:'ready'});
 await insertSession({
  sessionId:'session-peer',
  state:stateOf('running'),
  nodeId:'n1',
  worktreeId:'worktree-1',
 });
 await insertSession({
  sessionId:SESSION_ID,
  state:INTERRUPTED_NEEDS_REVIEW,
  nodeId:'n1',
  reviewRequired:true,
  worktreeId:'worktree-1',
  lastEventId:1,
 });
 await insertDummyEvent();
 const ingress=repository();
 const rejected=committedApplication(
  (await ingress.commitBatch('n1',batch(adoptEnvelope(1,'attempt-a'))))[0],
 );
 expect(rejected.applied).toBe(false);
 expect(rejected.rejectionReason)
  .toBe(SESSION_REJECTION_REASON_WIRE.worktree_busy);
 expectSameState(
  await storedValue(SESSION_ID),
  INTERRUPTED_NEEDS_REVIEW,
  'occupied adoption',
 );
 await h.sql`
 UPDATE sessions SET status='completed',updated_at=NOW()
 WHERE session_id='session-peer'`;
 const applied=await ingress.commitBatch(
  'n1',
  batch(adoptEnvelope(2,'attempt-b')),
 );
 expect(applied[0]?.outcome).toBe('committed');
 if(applied[0]?.outcome!=='committed')throw new Error('not committed');
 expect(applied[0].duplicateReceipt).toBe(false);
 expect(applied[0].sessionEffectApplication?.applied).toBe(true);
 expectSameState(
  await storedValue(SESSION_ID),
  RUNNING_NEEDS_REVIEW,
  'released adoption',
 );
},120000);

it('revives a disconnected session again after adoption and disconnect cleanup',async()=>{
 await reset();
 await insertSession({
  sessionId:SESSION_ID,
  state:INTERRUPTED_NEEDS_REVIEW,
  nodeId:'n1',
  reviewRequired:true,
  lastEventId:1,
 });
 await insertDummyEvent();
 const ingress=repository();
 const first=committedApplication(
  (await ingress.commitBatch('n1',batch(adoptEnvelope(1,'attempt-a'))))[0],
 );
 expect(first.applied).toBe(true);
 expectSameState(
  await storedValue(SESSION_ID),
  RUNNING_NEEDS_REVIEW,
  'first adoption',
 );
 const mutations=new SessionMutationRepository(h.sql);
 const cleanup=await mutations.reconcileNodeDisconnected(
  'n1',
  new Date(),
  'node_disconnect',
 );
 expect(cleanup.updates.some(update=>update.sessionId===SESSION_ID)).toBe(true);
 expectSameState(
  await storedValue(SESSION_ID),
  INTERRUPTED_NEEDS_REVIEW,
  'disconnect cleanup',
 );
 const second=committedApplication(
  (await ingress.commitBatch('n1',batch(adoptEnvelope(2,'attempt-b'))))[0],
 );
 expect(second.applied).toBe(true);
 expectSameState(
  await storedValue(SESSION_ID),
  RUNNING_NEEDS_REVIEW,
  'second adoption',
 );
},120000);

it('replays a rejected adoption attempt without applying the effect again',async()=>{
 await reset();
 await insertWorktree('worktree-1',{state:'ready'});
 await insertSession({
  sessionId:'session-peer',
  state:stateOf('running'),
  nodeId:'n1',
  worktreeId:'worktree-1',
 });
 await insertSession({
  sessionId:SESSION_ID,
  state:INTERRUPTED_NEEDS_REVIEW,
  nodeId:'n1',
  reviewRequired:true,
  worktreeId:'worktree-1',
  lastEventId:1,
 });
 await insertDummyEvent();
 const ingress=repository();
 const first=committedApplication(
  (await ingress.commitBatch('n1',batch(adoptEnvelope(1,'attempt-a'))))[0],
 );
 expect(first.applied).toBe(false);
 expect(first.rejectionReason)
  .toBe(SESSION_REJECTION_REASON_WIRE.worktree_busy);
 const otherSeq=committedApplication(
  (await ingress.commitBatch('n1',batch(adoptEnvelope(2,'attempt-a'))))[0],
 );
 expect(otherSeq.applied).toBe(false);
 expect(otherSeq.rejectionReason)
  .toBe(SESSION_REJECTION_REASON_WIRE.worktree_busy);
 const replay=await ingress.commitBatch(
  'n1',
  batch(adoptEnvelope(1,'attempt-a')),
 );
 expect(replay[0]?.outcome).toBe('committed');
 if(replay[0]?.outcome!=='committed')throw new Error('not committed');
 expect(replay[0].duplicateReceipt).toBe(true);
 expect(replay[0].sessionEffectApplication?.applied).toBe(false);
 expect(replay[0].sessionEffectApplication?.rejectionReason)
  .toBe(SESSION_REJECTION_REASON_WIRE.worktree_busy);
 expectSameState(
  await storedValue(SESSION_ID),
  INTERRUPTED_NEEDS_REVIEW,
  'rejected adoption',
 );
 // 첫 시도와 다른 source_seq 재시도가 사건을 하나씩 더했고, 같은 source_seq
 // 재전송은 수령증을 되읽어 사건도 효과도 다시 만들지 않았다.
 const [counts]=await h.sql<Array<{count:number}>>`
 SELECT COUNT(*)::int AS count FROM events WHERE session_id=${SESSION_ID}`;
 expect(counts?.count).toBe(3);
},120000);

it('rejects state events from a foreign owner node and accepts NULL owners',async()=>{
 const ingress=repository();
 const commands=[
  'running_transition',
  'execution_registration',
  'terminal_transition',
 ] as const;
 for(const command of commands){
  await reset();
  await insertSession({
   sessionId:SESSION_ID,
   state:RUNNING_ACK,
   nodeId:'n2',
   lastEventId:1,
  });
  await insertDummyEvent();
  const rejected=committedApplication(
   (await ingress.commitBatch('n1',batch(ownerEnvelope(command,1))))[0],
  );
  expect(rejected.applied,command).toBe(false);
  expect(rejected.rejectionReason,command)
   .toBe(wireReason(ownerMismatchRow(command,RUNNING_ACK)));
  expectSameState(await storedValue(SESSION_ID),RUNNING_ACK,command);

  await reset();
  await insertSession({
   sessionId:SESSION_ID,
   state:RUNNING_ACK,
   nodeId:null,
   lastEventId:1,
  });
  await insertDummyEvent();
  const accepted=committedApplication(
   (await ingress.commitBatch('n1',batch(ownerEnvelope(command,1))))[0],
  );
  expect(accepted.applied,command).toBe(true);
  const expected=tableRow(command,RUNNING_ACK,ownerFacts(command,'match'));
  expectSameState(
   await storedValue(SESSION_ID),
   expected.decision.next,
   `${command} null owner`,
  );
 }
},120000);

it('rejects a foreign-owner registration before the stale registration dead-letter',async()=>{
 await reset();
 await insertSession({
  sessionId:SESSION_ID,
  state:RUNNING_ACK,
  nodeId:'n2',
  lastEventId:1,
  executionRegistrationId:'registration-current',
  executionCommandId:'command-current',
 });
 await insertDummyEvent();
 const ingress=repository();
 const envelope={
  ...ownerEnvelope('execution_registration',1),
  registration_id:'registration-stale',
 };
 const result=await ingress.commitBatch('n1',batch(envelope));
 expect(result[0]?.outcome).toBe('committed');
 const application=committedApplication(result[0]);
 expect(application.applied).toBe(false);
 expect(application.rejectionReason)
  .toBe(wireReason(ownerMismatchRow('execution_registration',RUNNING_ACK)));
 expectSameState(await storedValue(SESSION_ID),RUNNING_ACK,'foreign registration');
},120000);
