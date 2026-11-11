import { describe, expect, it } from "vitest";
import { transition } from "xstate";
import { cardMachine } from "../src/cards/state/card_machine.js";
import { cardFactsToStateValue } from "../src/cards/state/card_machine_facts.js";
import { CARD_PROMISES, checkCardPromises, questionAnswersDiffer, questionAuthorCannotWithdraw } from "../src/cards/state/card_machine_promises.js";

describe("현행 카드 규칙의 약속", () => {
  it("질문 약속은 지키고 남은 어긋남을 정의의 전이와 구멍으로 찾는다", () => {
    const result = checkCardPromises();
    expect(result.promises.slice(0,4).map(p=>p.kept)).toEqual([false,false,true,true]);
    expect(new Set(result.marks.transitions.flatMap(t=>t.discrepancies))).toEqual(new Set([1,2,7]));
    expect(result.holes.filter(h=>h.id!=="holeOrphan").every(h=>h.reachable)).toBe(true);
    expect(result.holes.find(h=>h.id==="holeOrphan")?.reachable).toBe(false);
    expect(result.cardEntryPromise.kept).toBe(false);
    expect(result.promises[4]!.kept).toBe(false);
    expect(result.promises[5]!.kept).toBe(false);
  });
  it("담당을 바꾸면 실제 예약은 사라지고 약속 검사용 이력만 남는다", () => {
    let s = cardMachine.resolveState({ value: cardFactsToStateValue({status:"running",assignee:"originalLive",supervised:false,boardEntryCount:0,cardEntryCount:0,questionEntryCount:0}) });
    s = transition(cardMachine,s,{type:"SERVER_SHORT_LIMIT"})[0];
    expect(s.matches({reservation:"limit"})).toBe(true);
    s = transition(cardMachine,s,{type:"REPLACE_LIVE"})[0];
    expect(s.matches({reservation:"none"})).toBe(true);
    expect(s.matches({limitedOwner:"different"})).toBe(true);
    expect(transition(cardMachine,s,{type:"SERVER_LIVE_RESUME"})[0].matches({status:{on:"running"}})).toBe(true);
  });
  it("위반을 심은 구성과 지킨 구성을 판정기가 구분한다",()=>{
    const state=(extra:Partial<Parameters<typeof cardFactsToStateValue>[0]>)=>cardMachine.resolveState({value:cardFactsToStateValue({status:"blocked",blockedKind:"question",assignee:"originalLive",supervised:true,boardEntryCount:0,cardEntryCount:0,questionEntryCount:0,openQuestion:"owner",...extra})});
    const cases:[number,Parameters<typeof state>[0],Parameters<typeof state>[0]][]=[
      [0,{questionEntryCount:0},{questionEntryCount:1,boardEntryCount:1}],
      [1,{blockedKind:"limit",limitedOwner:"different",assignee:"replacedLive"},{blockedKind:"limit",limitedOwner:"same",assignee:"originalLive",limitResumeAt:new Date()}],
      [4,{blockedKind:"limit",limitedOwner:"different"},{blockedKind:"limit",limitedOwner:"same",limitResumeAt:new Date()}],
      [5,{questionEntryCount:0},{questionEntryCount:1,boardEntryCount:1}],
    ];
    cases.forEach(([i,bad,good])=>{
      expect(CARD_PROMISES[i]!.breaks(state(bad))).toBe(true);
      expect(CARD_PROMISES[i]!.breaks(state(good))).toBe(false);
    });
  });
  it("약속 판정기는 위반을 실제로 구분한다", () => {
    const result = checkCardPromises();
    for (const promise of result.promises.filter((_,i)=>i!==2&&i!==3)) {
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
});
