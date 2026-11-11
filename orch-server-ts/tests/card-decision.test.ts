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
