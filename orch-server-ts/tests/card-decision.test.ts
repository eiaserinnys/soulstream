import { expect, it } from 'vitest';
import { decodeCardDecision } from '../src/cards/state/card_decision_decoder.js';
import { decideCardTransition } from '../src/cards/state/card_decision.js';
import { rowToStateValue, stateValueToColumns } from '../src/cards/state/card_machine_facts.js';

const row = { status: 'running', blocked_kind: null, blocked_detail: null, archived: false, assignee_kind: 'session', assignee_session_id: 'owner', wake_at: null, limit_resume_session_id: null, limit_resume_at: null };
it('keeps rejected commands in all stored regions', () => {
  const result = decideCardTransition(row, [], {}, { type: 'SET_STATUS', status: 'done' }, { kind: 'agent', sessionId: 'other' }, 0);
  expect(result.kind).toBe('reject');
  expect(result.next).toEqual(rowToStateValue(row, []));
});
it('changes question and status together in one pure transition', () => {
  const result = decideCardTransition(row, [], {}, { type: 'ASK_QUESTION', text: '확인', options: ['진행'] }, { kind: 'agent', sessionId: 'owner' }, 0);
  expect(result.kind).toBe('apply');
  expect(result.next).toMatchObject({ question: 'open', status: { on: { talk: 'question' } } });
  expect(result.actions.some((a: any) => a.type === 'writeStatus')).toBe(true);
});
it('round trips every persisted state dimension', () => {
  for (const status of ['todo', 'queued', 'running', 'blocked', 'review', 'awaiting_verification', 'on_hold', 'done', 'cancelled']) {
    const r = { ...row, status };
    expect(stateValueToColumns(rowToStateValue(r, [])).status).toBe(status);
  }
});

it('preserves verification reservations for assignment-only writes',()=>{
 const r={...row,status:'awaiting_verification',wake_at:'2026-11-12T00:00:00.000Z',waiting_for:'확인'};
 for(const type of ['PATCH_CARD_CONTROL','REGISTER_REPLACEMENT','NOTE_MISSING'] as const){
 const command={type,assignee:{kind:'session',sessionId:'new-owner'},sessionId:'new-owner'};
 const result=decideCardTransition(r,[],{previousOwnerMatch:true},command,{kind:'agent',sessionId:'pas'},0);
 expect(result.kind).toBe('apply');expect(result.next.reservation).toBe('verify');
 }
 const explicit=decideCardTransition(r,[],{claim:false},{type:'SET_STATUS',status:'blocked',blockedKind:'limit'},{kind:'user',sessionId:null},0);
 expect(explicit.next.reservation).toBe('none');
});
it('writes the replacement notice when registered replacement clears a limit reservation',()=>{
 const r={...row,status:'blocked',blocked_kind:'limit',limit_resume_session_id:'owner'};
 const actor={kind:'agent',sessionId:'pas'},command={type:'REGISTER_REPLACEMENT' as const,sessionId:'new-owner'};
 const result=decideCardTransition(r,[],{previousOwnerMatch:true},command,actor,0);
 expect(result.kind).toBe('apply');expect(result.next.reservation).toBe('none');
 const notice={text:'담당이 바뀌어 자동 재개 예약을 해제했습니다'};
 const writes=decodeCardDecision(result,{card:r,command,actor,now:new Date(0),eventId:null,values:{'formatted.replacement':notice}});
 expect(writes).toHaveLength(1);
 expect(writes[0]!.fields).toMatchObject({assignee_session_id:'new-owner',limit_resume_session_id:null,limit_resume_at:null,now:notice});
});
it('preserves the eligible caller claim during bulk status changes',()=>{
 const r={...row,status:'todo',assignee_kind:'agent',assignee_agent_id:'worker',assignee_session_id:null};
 const actor={kind:'agent',sessionId:'candidate'},command={type:'BULK_SET_STATUS' as const,status:'queued'};
 const result=decideCardTransition(r,[],{claim:true,ownerState:'missing'},command,actor,0);
 expect(result.kind).toBe('apply');expect(result.next.assignee).toBe('session');
 const writes=decodeCardDecision(result,{card:r,command,actor,now:new Date(0),eventId:1,queuePosition:'Q'});
 expect(writes).toHaveLength(1);
 expect(writes[0]!.fields).toMatchObject({status:'queued',assignee_kind:'session',assignee_session_id:'candidate',assignee_agent_id:null});
});
it('preserves direct comment precedence while accepting the followup entrance',()=>{
 const r={...row,items:[{id:1}]},actor={kind:'agent',sessionId:'other'};
 const direct=decideCardTransition(r,[],{}, {type:'ADD_COMMENT',body:'상황 전달',entrance:'direct'},actor,0);
 expect(direct.kind).toBe('reject');
 if(direct.kind==='reject')expect(direct.failure.guard).toBe('reject.ADD_COMMENT.otherAssignee');
 const followup=decideCardTransition({...r,items:[]},[],{}, {type:'ADD_COMMENT',body:'후속',mode:'spoken',entrance:'followup'},actor,0);
 expect(followup.kind).toBe('noop');
});

it('leaves final reservation cleanup to patchCardTx while retaining requested writes',()=>{
 const r={...row,status:'awaiting_verification',wake_at:'2026-11-12T00:00:00.000Z',waiting_for:'확인'};
 const actor={kind:'user',sessionId:null},command={type:'SET_STATUS' as const,status:'done' as const};
 const decision=decideCardTransition(r,[],{},command,actor,0);
 const values={card:r,command,actor,now:new Date(0),eventId:null};
 const [full]=decodeCardDecision(decision,values),[requested]=decodeCardDecision(decision,values,true);
 expect(full!.fields).toMatchObject({wake_at:null,waiting_for:null,limit_resume_session_id:null,limit_resume_at:null});
 expect(requested!.fields).toMatchObject({status:'done',completed_kind:'user',completed_at:new Date(0)});
 for(const key of ['wake_at','waiting_for','limit_resume_session_id','limit_resume_at'])expect(requested!.fields).not.toHaveProperty(key);
 const verify={type:'SET_STATUS' as const,status:'awaiting_verification' as const,wakeAt:'2026-11-12T00:00:00.000Z',waitingFor:'확인'};
 const next=decideCardTransition(row,[],{},verify,actor,Date.parse('2026-11-11T00:00:00.000Z'));
 expect(decodeCardDecision(next,{...values,card:row,command:verify},true)[0]!.fields).toMatchObject({wake_at:verify.wakeAt,waiting_for:'확인'});
});
