import { expect,it } from 'vitest';
import { cardDecisionMachine } from '../src/cards/state/card_decision_machine.js';
import { rowToStateValue } from '../src/cards/state/card_state_value.js';
import { checkCardPromises, questionEntryMissing, cardEntryMissing, questionAnswersDiffer, questionAuthorCannotWithdraw, unrecordedLimitResume, shortLimitReservationMissing, questionEditChangesState, answerKindsShareResumeRule } from '../src/cards/state/card_machine_promises.js';
import type { CardWorld } from '../src/cards/state/card_machine_world.js';
const world=(status='blocked',question=true):CardWorld=>({snapshot:cardDecisionMachine.resolveState({value:rowToStateValue({status,blocked_kind:'question',assignee_kind:'session',archived:false},question?[{answer:null,withdrawn_at:null}]:[]),context:{}}),owner:'live',pas:'room',dismissed:false});
it('keeps promises 1-가 through 5, the question edit promise, and the known failure of promise 6',()=>{
 const r=checkCardPromises();
 expect(r.promises.slice(0,5).map(p=>p.violations)).toEqual([0,0,0,0,0]);
 expect(r.cardEntryPromise.violations).toBe(0);
 expect(r.promises[5]!.violations).toBeGreaterThan(0);
 expect(r.promises[6]!.violations).toBe(0);
 expect(r.promises[6]!.name).toBe('질문 제자리 고침은 열린 질문 수와 카드 상태를 바꾸지 않는다');
 expect(r.promises[7]!.violations).toBe(0);
 expect(r.promises[7]!.name).toBe('선택 답과 글 답은 같은 마지막 질문 재개 규칙을 쓴다');
 expect(r.holes.every(h=>!h.reachable)).toBe(true);
 console.log(JSON.stringify({worlds:r.configurationCount,promises:[r.promises[0]!,r.cardEntryPromise,...r.promises.slice(1)].map(p=>({name:p.name,violations:p.violations})),holes:r.holes}));
},300000);
it('detects injected board, answer and author withdrawal defects',()=>{
 const w=world();
 expect(questionEntryMissing(w)).toBe(false);expect(questionEntryMissing(w,()=>[])).toBe(true);
 const noQuestion=world('blocked',false);
 expect(cardEntryMissing(noQuestion)).toBe(false);expect(cardEntryMissing(noQuestion,()=>[])).toBe(true);
 expect(questionAnswersDiffer(w)).toBe(false);
 expect(questionAnswersDiffer(w,(state,boundary)=>boundary==='detail'?world('running',false):state)).toBe(true);
 expect(questionAuthorCannotWithdraw(w)).toBe(false);expect(questionAuthorCannotWithdraw(w,state=>state)).toBe(true);
});
it('detects injected unrecorded limit resume and missing short reservation',()=>{
 const w=world();
 w.snapshot=cardDecisionMachine.resolveState({value:rowToStateValue({status:'blocked',blocked_kind:'limit',assignee_kind:'session',archived:false},[]),context:{}});
 expect(unrecordedLimitResume(w)).toBe(false);expect(unrecordedLimitResume(w,()=>world('running',false))).toBe(true);
 const running={...world('running',false),owner:'shortLimit' as const};
 expect(shortLimitReservationMissing(running)).toBe(false);expect(shortLimitReservationMissing(running,state=>state)).toBe(true);
});
it('detects an injected question edit that changes card state',()=>{
 const w=world();
 expect(questionEditChangesState(w)).toBe(false);
 expect(questionEditChangesState(w,()=>world('running',false))).toBe(true);
});
it('detects an injected resume rule that depends on the answer kind',()=>{
 const w=world();
 expect(answerKindsShareResumeRule(w)).toBe(false);
 let call=0;
 expect(answerKindsShareResumeRule(w,()=>call++===0?world('running',false):world())).toBe(true);
});
