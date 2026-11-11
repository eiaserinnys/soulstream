import { expect, it } from 'vitest';
import { decideCardTransition } from '../src/cards/state/card_decision.js';
import { decodeCardDecision } from '../src/cards/state/card_decision_decoder.js';
import { deriveCardDecisionFacts } from '../src/cards/state/card_decision_facts.js';

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
