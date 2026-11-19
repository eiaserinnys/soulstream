import { expect, it } from 'vitest';
import { decideCardTransition } from '../src/cards/state/card_decision.js';
import { decodeCardDecision } from '../src/cards/state/card_decision_decoder.js';
import { deriveCardDecisionFacts } from '../src/cards/state/card_decision_facts.js';
import { serverCardEvidence, type ServerEvidenceRows } from '../src/cards/state/card_server_evidence.js';

it('requests only the next evidence stage and never writes before the final verdict',()=>{
 const row={id:'card',status:'queued',archived:false,assignee_kind:'agent'};
 const command={type:'DISPATCH' as const,sessionId:'worker',nodeId:'node',expectedVersion:1};
 const actor={kind:'system',sessionId:null};
 for(const [loaded,stage] of [[[],'pending'],[['pending'],'policy']] as const){
  const decision=decideCardTransition(row,[],{loaded:[...loaded],pending:false},command,actor,0);
  expect(decision.kind).toBe('needsEvidence');
  expect(decision).toHaveProperty('stage',stage);
  expect(decision.next.status).toEqual({on:{ready:{queued:'normal'}}});
  expect(decodeCardDecision(decision,{card:row,command,actor,now:new Date(0),eventId:null})).toEqual([]);
  expect(decision.actions.map(action=>action.type)).toEqual(['needsEvidence']);
 }
});

it('rejects state before asking for any evidence',()=>{
 const result=decideCardTransition({id:'card',status:'running'},[],{},
  {type:'DISPATCH',sessionId:'worker',nodeId:'node',expectedVersion:1},{kind:'system',sessionId:null},0);
 expect(result.kind).toBe('reject');
 expect(result).toHaveProperty('failure.id','queued');
});

it('leaves unread evidence absent instead of replacing it with false or ok',()=>{
 const facts=deriveCardDecisionFacts({id:'card',status:'queued'},[],{},
  {type:'DISPATCH',sessionId:'worker',nodeId:'node',expectedVersion:1},{kind:'system',sessionId:null},0);
 expect(facts.evidenceMissing).toBe('pending');
 for(const name of ['pending','policyEnabled','admission'])expect(facts).not.toHaveProperty(name);
});

// 노드가 빈 카드의 승인 대조는 설치 기본 노드와 후보 노드를 별도 값으로 비교한다.
// 재생 판정(순수 함수)과 운영 SQL이 같은 뜻을 가지도록 순수 쪽 판정을 고정한다.
function nullNodeAdmission(nodeId:string){return serverCardEvidence({
 rows:{sessions:[],registrations:[],deliveries:[],dispatchRuns:[],
  admissionRun:{id:'run',state:'decided',lease_token:'lease',lease_expires_at:'1970-01-01T00:00:10.000Z',policy_version:1,
   decision:{decisions:[{cardId:'card',cardVersion:1,action:'run'}]}},
  orchestrationPolicy:{version:1,value:{enabled:true}},dispatchPolicy:{value:{nodeConcurrency:{default:2}}},
  folders:[{id:'folder',archived:false}],capacitySessions:[],executionStatusChanged:false} as ServerEvidenceRows,
 card:{id:'card',version:1,archived:false,folder_id:'folder',assignee_kind:'agent',assignee_session_id:null,
  assignee_agent_id:'agent',node_id:null,model_preset:null},
 command:{type:'DISPATCH',sessionId:'worker',nodeId,expectedVersion:1,
  admission:{runId:'run',leaseToken:'lease',workerInput:{agentId:'agent',configuredModelPreset:null}}},
 actorSessionId:'worker',checkedAt:0,dispatches:[],requests:[],claimCandidates:[],resumeAt:null,defaultNodeId:'node-a'}).admission;}
it('admits a node-less card only for the install default candidate',()=>{
 expect(nullNodeAdmission('node-a')).toBe('ok');
 expect(nullNodeAdmission('node-b')).toBe('ineligible');
});
