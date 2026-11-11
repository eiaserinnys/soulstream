import { describe, expect, it } from "vitest";
import { transition } from "xstate";
import { cardMachine } from "../src/cards/state/card_machine.js";
import { cardFactsToStateValue } from "../src/cards/state/card_machine_facts.js";
import { CARD_PROMISES, checkCardPromises, questionAnswersDiffer, questionAuthorCannotWithdraw, unrecordedLimitResume, shortLimitReservationMissing } from "../src/cards/state/card_machine_promises.js";

describe("현행 카드 규칙의 약속", () => {
  it("질문 약속은 지키고 남은 어긋남을 정의의 전이와 구멍으로 찾는다", () => {
    const result = checkCardPromises();
    expect(result.promises.slice(0,4).map(p=>p.kept)).toEqual([false,true,true,true]);
    expect(new Set(result.marks.transitions.flatMap(t=>t.discrepancies))).toEqual(new Set([1,7]));
    expect(result.holes.filter(h=>h.id!=="holeOrphan"&&h.id!=="holeChangedLimitOwner").every(h=>h.reachable)).toBe(true);
    expect(result.holes.find(h=>h.id==="holeOrphan")?.reachable).toBe(false);
    expect(result.cardEntryPromise.kept).toBe(false);
    expect(result.promises[4]!.kept).toBe(true);
    expect(result.promises[5]!.kept).toBe(false);
  });
  it("담당을 바꾸면 카드의 예약과 담당 기록을 함께 지운다", () => {
    let s = cardMachine.resolveState({ value: cardFactsToStateValue({status:"running",assignee:"originalLive",supervised:false,boardEntryCount:0,cardEntryCount:0,questionEntryCount:0}) });
    s = transition(cardMachine,s,{type:"SERVER_SHORT_LIMIT"})[0];
    expect(s.matches({reservation:"limit"})).toBe(true);
    s = transition(cardMachine,s,{type:"REPLACE_LIVE"})[0];
    expect(s.matches({reservation:"none"})).toBe(true);
    expect(s.matches({limitedOwner:"none"})).toBe(true);
    expect(transition(cardMachine,s,{type:"SERVER_LIVE_RESUME"})[0].matches({status:{on:{silent:"limit"}}})).toBe(true);
  });
  it("위반을 심은 구성과 지킨 구성을 판정기가 구분한다",()=>{
    const state=(extra:Partial<Parameters<typeof cardFactsToStateValue>[0]>)=>cardMachine.resolveState({value:cardFactsToStateValue({status:"blocked",blockedKind:"question",assignee:"originalLive",supervised:true,boardEntryCount:0,cardEntryCount:0,questionEntryCount:0,openQuestion:"owner",...extra})});
    const cases:[number,Parameters<typeof state>[0],Parameters<typeof state>[0]][]=[
      [0,{questionEntryCount:0},{questionEntryCount:1,boardEntryCount:1}],
      [5,{questionEntryCount:0},{questionEntryCount:1,boardEntryCount:1}],
    ];
    cases.forEach(([i,bad,good])=>{
      expect(CARD_PROMISES[i]!.breaks(state(bad))).toBe(true);
      expect(CARD_PROMISES[i]!.breaks(state(good))).toBe(false);
    });
  });
  it("약속 판정기는 위반을 실제로 구분한다", () => {
    const result = checkCardPromises();
    for (const promise of result.promises.filter((_,i)=>i===0||i===5)) {
      expect(promise.violations).toBeGreaterThan(0);
      expect(promise.example.length).toBeGreaterThan(0);
    }
  });
  it("질문 판정기에 답 거절과 작성자 철회 금지 결함을 심으면 빨강이 된다",()=>{
    const make=(status:"done"|"blocked",assignee:"none"|"originalLive",openQuestion:"owner"|"orphan")=>cardMachine.resolveState({value:cardFactsToStateValue({status,blockedKind:"question",assignee,openQuestion,supervised:false,boardEntryCount:0,cardEntryCount:0,questionEntryCount:0})});
    const done=make("done","originalLive","owner");
    const orphan=make("blocked","none","orphan");
    expect(questionAnswersDiffer(done)).toBe(false);
    expect(questionAnswersDiffer(done,(s,event)=>event==="ANSWER_BOARD"?s:transition(cardMachine,s,{type:event})[0])).toBe(true);
    expect(questionAuthorCannotWithdraw(orphan)).toBe(false);
    expect(questionAuthorCannotWithdraw(orphan,s=>s)).toBe(true);
    expect(transition(cardMachine,orphan,{type:"WITHDRAW_AUTHOR"})[0].matches({question:"none"})).toBe(true);
  });
  it("예약 판정기는 기록 없는 재개와 시각 누락을 심으면 빨강이다",()=>{
    const state=(status:"running"|"blocked")=>cardMachine.resolveState({value:cardFactsToStateValue({status,blockedKind:"limit",assignee:"originalLive",supervised:false,boardEntryCount:0,cardEntryCount:0,questionEntryCount:0})});
    const blocked=state("blocked"),running=state("running");
    expect(unrecordedLimitResume(blocked)).toBe(false);
    expect(unrecordedLimitResume(blocked,()=>running)).toBe(true);
    expect(shortLimitReservationMissing(running)).toBe(false);
    expect(shortLimitReservationMissing(running,()=>blocked)).toBe(true);
  });
});
