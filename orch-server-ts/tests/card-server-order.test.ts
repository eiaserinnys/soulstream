import { expect, it } from 'vitest';
import type { CardControlPlaneService as Service } from '../src/cards/card_control_plane_service.js';
const {CardControlPlaneService}=await import(process.env.CARD_BASELINE_SERVICE??'../src/cards/card_control_plane_service.js');
import { decideCardTransition } from '../src/cards/state/card_decision.js';
import { formatCardDecisionRejection } from '../src/cards/state/card_decision_errors.js';
import type { RepositorySql } from '../src/cards/control_plane/card_types.js';
import type { FolderMutateParams } from '../src/cards/control_plane/card_mutation_core.js';

// Public-method/transaction callback harness, as in card-formatter-order.test.ts.
const row={id:'card',folder_id:'folder',version:2,status:'queued',archived:false,
  assignee_kind:'agent',assignee_agent_id:'worker',assignee_session_id:null,
  limit_resume_session_id:null,limit_resume_at:null,wake_at:null};
const command={type:'DISPATCH' as const,cardId:'card',expectedVersion:2,sessionId:'worker-session',nodeId:'node',
  admission:{runId:'run',leaseToken:'lease',workerInput:{agentId:'worker'}}};

function harness(status='queued',options:{pending?:boolean;enabled?:boolean;lockedEnabled?:boolean;run?:boolean;capacity?:number;full?:boolean;eligible?:boolean;execution?:boolean;active?:boolean;receipt?:boolean;admitted?:boolean;termination?:boolean}={},overrides:Record<string,unknown>={}) {
  const queries:string[]=[];
  const card={...row,status,...overrides};
  const sql=Object.assign(async(strings:TemplateStringsArray)=>{
    const query=strings.join('');queries.push(query);
    if(query.includes('SELECT * FROM cards'))return [structuredClone(card)];
    if(query.includes("setting_key='card_orchestration'"))
      return [{enabled:query.includes('FOR SHARE')?options.lockedEnabled??false:options.enabled??true,version:1}];
    if(query.includes('card_execution_requests'))return options.pending?[{id:'pending'}]:[];
    if(query.includes('FROM card_orchestration_runs'))return options.run?[{policy_version:1,decision:{decisions:[{cardId:'card',cardVersion:2,action:'run'}]}}]:[];
    if(query.includes('pg_advisory_xact_lock'))return [];
    if(query.includes("setting_key='card_dispatch'"))return options.capacity===undefined?[]:[{limit:options.capacity}];
    if(query.includes('SELECT DISTINCT session_id,node_id'))return options.full?[{session_id:'occupied',node_id:'node'}]:[];
    if(query.includes('SELECT c.id FROM cards'))return options.eligible?[{id:'card'}]:[];
    if(query.includes('SELECT card_id FROM sessions'))return [{card_id:'card'}];
    if(query.includes('SELECT c.status_changed_at'))return [{changed:false}];
    if(query.includes('SELECT session_id FROM sessions'))return options.execution?[{session_id:'worker-session'}]:[];
    if(query.includes('SELECT * FROM card_orchestration_dispatches'))return options.active?[{run_id:'run',created_at:new Date(0),input:{agentId:'worker'}}]:[];
    if(query.includes('SELECT event_id FROM event_ingress_receipts'))return options.receipt?[{event_id:1}]:[];
    if(query.includes('SELECT d.run_id'))return options.admitted?[{run_id:'run'}]:[];
    if(query.includes('SELECT s.session_id FROM cards'))return [];
    if(query.includes('SELECT session_id,status,termination_reason'))return options.termination?[{session_id:'worker-session',status:'error',termination_reason:'limit_hit',termination_event_id:9}]:[];
    if(query.includes('WITH bounds'))return [];
    if(query.includes('INSERT INTO card_orchestration_dispatches')||query.includes('UPDATE card_orchestration_dispatches'))return [];
    throw Error(`Unexpected SQL: ${query}`);
  },{json:(v:unknown)=>v}) as unknown as RepositorySql;
  const service=Object.create(CardControlPlaneService.prototype) as Service;
  Object.assign(service,{repo:{getCard:async()=>structuredClone(card)},repoSql:sql,
    core:{mutate:async(p:FolderMutateParams)=>{await p.apply(sql,1);return {idempotent:false,operation:{payload_json:p.payload}};}},
    patch:async(_sql:unknown,_row:unknown,fields:Record<string,unknown>)=>{Object.assign(card,fields);},
  });
  return {service,queries,card};
}

it('baseline 50f25bbfc keeps the locked policy disabled failure without statusCode or code',async()=>{
  const h=harness();
  const error=await h.service.recordDispatch(command).then(()=>null,e=>e);
  expect(error.message).toBe('Orchestration policy is disabled');
  expect(error.statusCode).toBeUndefined();
  expect(error.code).toBeUndefined();
  expect(h.queries.filter(q=>q.includes("setting_key='card_orchestration'"))).toHaveLength(2);
  expect(h.queries.at(-1)).toContain('FOR SHARE');
});

it('baseline 50f25bbfc rejects a nonqueued card before reading or locking policy',async()=>{
  const h=harness('running');
  await expect(h.service.recordDispatch(command)).rejects.toMatchObject({
    message:'Only queued cards may dispatch',statusCode:422,code:'INVALID_CARD_REQUEST',
  });
  expect(h.queries).toHaveLength(1);
  expect(h.queries[0]).toContain('SELECT * FROM cards');
  expect(h.queries[0]).toContain('FOR UPDATE');
});

it('represents the locked fence failure separately from the first policy read',()=>{
  const decision=decideCardTransition(row,[],{loaded:['pending','policy','admission'],pending:false,policyEnabled:true,admission:'lockedPolicyDisabled'},command,
    {kind:'system',sessionId:null},Date.now());
  expect(decision.kind).toBe('reject');
  if(decision.kind!=='reject')throw Error('Expected locked-policy rejection');
  expect(formatCardDecisionRejection(command.type,row.id,decision.failure))
    .toMatchObject({message:'Orchestration policy is disabled',statusCode:null,code:null});
});

const limit={assignee_kind:'session',assignee_session_id:'worker-session',blocked_kind:'limit',limit_resume_session_id:'worker-session',limit_resume_at:null};
for(const method of ['recordDispatch','resumeDispatchedCard'] as const){
 for(const [name,options,count,message] of [
  ['pending',{pending:true},2,'실행 결과 확인 중입니다. 같은 요청의 결과를 확인하세요.'],
  ['disabled',{enabled:false},3,'Orchestration policy is disabled'],
  ['lockedDisabled',{},4,'Orchestration policy is disabled'],
  ['stale',{lockedEnabled:true},5,'Stale orchestration admission'],
  ['missingCapacity',{lockedEnabled:true,run:true},7,'Missing node capacity'],
  ['capacity',{lockedEnabled:true,run:true,capacity:1,full:true},8,'Node capacity is full'],
  ['ineligible',{lockedEnabled:true,run:true,capacity:1},9,'Card is no longer eligible'],
 ] as const)it(`baseline 50f25bbfc ${method}: ${name} SQL prefix`,async()=>{
  const h=harness(method==='recordDispatch'?'queued':'blocked',options,method==='recordDispatch'?{}:limit);
  const error=await h.service[method](command).then(()=>null,e=>e);
  expect(error.message).toBe(name==='pending'?'실행 결과 확인 중입니다. 같은 요청의 결과를 확인하세요.':message);
  expect(h.queries).toHaveLength(count);
  expect(h.queries[0]).toContain('FOR UPDATE');
  if(count>=2)expect(h.queries[1]).toContain('card_execution_requests');
  if(count>=3){expect(h.queries[2]).toContain("setting_key='card_orchestration'");expect(h.queries[2]).not.toContain('FOR SHARE');}
  if(count>=4)expect(h.queries[3]).toContain('FOR SHARE');
  if(count>=8)expect(h.queries[7]).toContain('SELECT DISTINCT session_id,node_id');
  if(count>=9)expect(h.queries[8]).toContain('SELECT c.id FROM cards');
  if(count>=5)expect(h.queries[4]).toContain('FOR UPDATE');
  if(count>=7)expect(h.queries[5]).toContain('pg_advisory_xact_lock');
  if(count>=7)expect(h.queries[6]).toContain('FOR SHARE');
 });
 it(`baseline 50f25bbfc ${method}: version before any later rejection`,async()=>{
  const h=harness();
  await expect(h.service[method]({...command,expectedVersion:1})).rejects.toMatchObject({statusCode:409});
  expect(h.queries).toHaveLength(1);
 });
 it(`baseline 50f25bbfc ${method}: policy enabled requires admission without locking policy`,async()=>{
  const h=harness(method==='recordDispatch'?'queued':'blocked',{},method==='recordDispatch'?{}:limit);
  await expect(h.service[method]({...command,admission:undefined})).rejects.toMatchObject({message:'Enabled orchestration requires a fenced decision admission',statusCode:422});
  expect(h.queries).toHaveLength(3);
  expect(h.queries.at(-1)).not.toContain('FOR SHARE');
 });
}

it('baseline 50f25bbfc long limit rejects state before pending and policy reads',async()=>{
 const h=harness('running');
 await expect(h.service.resumeDispatchedCard(command)).rejects.toThrow('Only the recorded current long-limit assignee may resume');
 expect(h.queries).toHaveLength(1);
});
it('baseline 50f25bbfc start rejects actor before the card lock and version',async()=>{
 const h=harness();
 await expect(h.service.startCardWork({cardId:'card',actorKind:'user',actorSessionId:null,expectedVersion:1,execution:{registrationId:'r',executionCommandId:'c'}})).rejects.toMatchObject({code:'INVALID_CARD_WORK'});
 expect(h.queries).toHaveLength(0);
});
for(const [name,options,count,message] of [
 ['execution',{},2,'Current execution is missing, stale or orchestration purpose'],
 ['owner',{execution:true},4,'Only the current assignee session may start work.'],
 ['receipt',{execution:true,active:true},5,'Only the current assignee session may start work.'],
 ['admission',{execution:true,active:true,receipt:true},5,'Automatic work requires a valid fenced admission for its assignee'],
] as const)it(`baseline 50f25bbfc start: ${name} SQL prefix`,async()=>{
 const h=harness('queued',options,{assignee_kind:'session',assignee_session_id:'other'});
 await expect(h.service.startCardWork({cardId:'card',actorKind:'agent',actorSessionId:'worker-session',execution:{registrationId:'r',executionCommandId:'c'}})).rejects.toThrow(message);
 expect(h.queries).toHaveLength(count);
 expect(h.queries[1]).toContain('FROM sessions');expect(h.queries[1]).not.toMatch(/FOR (SHARE|UPDATE)/);
 if(count>=4)expect(h.queries[2]).toContain('FOR UPDATE');
});
it('baseline 50f25bbfc confirm rejects session mismatch after the session read, before status timestamp',async()=>{
 const h=harness('running',{}, {assignee_kind:'session',assignee_session_id:'other'});
 await expect(h.service.recordExecution({cardId:'card',actorKind:'system',actorSessionId:null,requestId:'request',sessionId:'worker-session'})).rejects.toThrow('실행 세션과 카드 담당이 일치하지 않습니다.');
 expect(h.queries).toHaveLength(2);
 expect(h.queries[1]).toContain('FROM sessions');expect(h.queries[1]).not.toMatch(/FOR (SHARE|UPDATE)/);
});
it('baseline 50f25bbfc block limit rejects state before the owner read',async()=>{
 const h=harness('queued');
 await expect(h.service.blockCardForLimit({cardId:'card',expectedVersion:2,sessionId:'worker-session',terminationEventId:9})).rejects.toThrow('Only the current running assignee may enter limit-blocked');
 expect(h.queries).toHaveLength(1);
});
it('baseline 50f25bbfc block limit rejects termination before reset-event reads',async()=>{
 const h=harness('running',{},limit);
 await expect(h.service.blockCardForLimit({cardId:'card',expectedVersion:2,sessionId:'worker-session',terminationEventId:9})).rejects.toThrow('Quota termination changed before the card was blocked');
 expect(h.queries).toHaveLength(2);
 expect(h.queries[1]).toContain('FROM sessions');expect(h.queries[1]).not.toMatch(/FOR (SHARE|UPDATE)/);
});
for(const [now,expectedCount,success] of [[999,1,false],[1000,3,true],[1001,3,true]] as const)it(`baseline 50f25bbfc short limit due boundary ${now}`,async()=>{
 const at=new Date(1000).toISOString(),h=harness('blocked',{}, {...limit,limit_resume_at:at});
 const call=h.service.resumeLimitedCard({cardId:'card',sessionId:'worker-session',resumeAt:at,now});
 if(success)await call;else await expect(call).rejects.toThrow("Only the current assignee's unchanged due limit reservation may resume");
 expect(h.queries).toHaveLength(expectedCount);
 if(success)expect(h.card.status).toBe('running');
});
it('baseline 50f25bbfc short limit pending rejection reads only card and pending requests',async()=>{
 const at=new Date(1000).toISOString(),h=harness('blocked',{pending:true},{...limit,limit_resume_at:at});
 await expect(h.service.resumeLimitedCard({cardId:'card',sessionId:'worker-session',resumeAt:at,now:1000})).rejects.toMatchObject({code:'CARD_EXECUTION_PENDING'});
 expect(h.queries).toHaveLength(2);
});
it('baseline 50f25bbfc verification mismatch has no evidence SQL',async()=>{
 const h=harness('running');
 await expect(h.service.resumeVerificationCard({cardId:'card',sessionId:'worker-session',wakeAt:new Date(1000).toISOString()})).rejects.toThrow('Only the currently assigned verification-wait card at this wake time may resume');
 expect(h.queries).toHaveLength(1);
});
it('baseline 50f25bbfc missing assignee writes detail without any evidence read',async()=>{
 const h=harness('queued');
 await h.service.noteMissingAssignee({cardId:'card',expectedVersion:2});
 expect(h.queries).toHaveLength(2);
 expect(h.card).toHaveProperty('blocked_detail','담당 에이전트 없음');
});
it('baseline 50f25bbfc confirm reads timestamp only after session and preserves a later done state',async()=>{
 const h=harness('done',{}, {assignee_kind:'session',assignee_session_id:'worker-session'});
 await h.service.recordExecution({cardId:'card',actorKind:'system',actorSessionId:null,requestId:'request',sessionId:'worker-session'});
 expect(h.queries).toHaveLength(4);
 expect(h.queries[1]).toContain('SELECT card_id FROM sessions');
 expect(h.queries[1]).toContain('FROM sessions');expect(h.queries[1]).not.toMatch(/FOR (SHARE|UPDATE)/);
 expect(h.queries[2]).toContain('status_changed_at>r.updated_at');
 expect(h.card.status).toBe('done');
});
it('baseline 50f25bbfc valid termination reads reset events only after the owner read',async()=>{
 const h=harness('running',{termination:true},limit);
 await h.service.blockCardForLimit({cardId:'card',expectedVersion:2,sessionId:'worker-session',terminationEventId:9});
 expect(h.queries).toHaveLength(4);
 expect(h.queries[1]).toContain('FROM sessions');expect(h.queries[1]).not.toMatch(/FOR (SHARE|UPDATE)/);
 expect(h.queries[2]).toContain('WITH bounds');
 expect(h.card).toMatchObject({status:'blocked',limit_resume_session_id:'worker-session',limit_resume_at:null});
});
it('baseline 50f25bbfc accepted automatic work updates dispatch before card and skips claim SQL',async()=>{
 const h=harness('queued',{execution:true,active:true,receipt:true,admitted:true});
 await h.service.startCardWork({cardId:'card',actorKind:'agent',actorSessionId:'worker-session',execution:{registrationId:'r',executionCommandId:'c'}});
 expect(h.queries).toHaveLength(7);
 expect(h.queries[2]).toContain('FOR UPDATE');
 expect(h.queries[3]).toContain('SELECT event_id FROM event_ingress_receipts');
 expect(h.queries[4]).toContain('SELECT d.run_id');
 expect(h.queries[5]).toContain('UPDATE card_orchestration_dispatches');
 expect(h.queries.some(q=>q.includes('SELECT s.session_id FROM cards'))).toBe(false);
 expect(h.card.status).toBe('running');
});
it('baseline 50f25bbfc matching verification wake resumes without extra evidence SQL',async()=>{
 const wakeAt=new Date(1000).toISOString();
 const h=harness('awaiting_verification',{}, {assignee_kind:'session',assignee_session_id:'worker-session',wake_at:wakeAt,waiting_for:'확인'});
 await h.service.resumeVerificationCard({cardId:'card',sessionId:'worker-session',wakeAt});
 expect(h.queries).toHaveLength(2);
 expect(h.card.status).toBe('running');
});
it('baseline 50f25bbfc unchanged short reservation rejects a different wake timestamp before pending SQL',async()=>{
 const h=harness('blocked',{}, {...limit,limit_resume_at:new Date(1000).toISOString()});
 await expect(h.service.resumeLimitedCard({cardId:'card',sessionId:'worker-session',resumeAt:new Date(1001).toISOString(),now:2000})).rejects.toThrow("Only the current assignee's unchanged due limit reservation may resume");
 expect(h.queries).toHaveLength(1);
});
it.each(['execution','work','limit','missing'] as const)('baseline 50f25bbfc %s version conflict precedes evidence',async family=>{
 const h=harness();
 const params={cardId:'card',expectedVersion:1};
 const call=family==='execution'?h.service.recordExecution({...params,actorKind:'system',actorSessionId:null,requestId:'request',sessionId:'worker-session'}):
  family==='work'?h.service.startCardWork({...params,actorKind:'agent',actorSessionId:'worker-session',execution:{registrationId:'r',executionCommandId:'c'}}):
  family==='limit'?h.service.blockCardForLimit({...params,sessionId:'worker-session',terminationEventId:9}):h.service.noteMissingAssignee(params);
 await expect(call).rejects.toMatchObject({statusCode:409});
 expect(h.queries).toHaveLength(1);
});
