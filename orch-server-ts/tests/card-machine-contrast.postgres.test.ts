import { afterAll, beforeAll, expect, it } from "vitest";
import { transition } from "xstate";
import { cardContrastPaths, transitionIds } from "../src/cards/state/card_machine_paths.js";
import { cardMachine, type CardSnapshot } from "../src/cards/state/card_machine.js";
import { cardFactsToStateValue } from "../src/cards/state/card_machine_facts.js";
import { createCardMachineWorld, type CardMachineWorld } from "./card-machine-world.js";

let world:CardMachineWorld;
beforeAll(async()=>{world=await createCardMachineWorld();},60000);
afterAll(async()=>{await world?.cleanup();});
const initial=()=>cardMachine.resolveState({value:cardFactsToStateValue({status:"uncreated",assignee:"none"})});
async function run(events:string[]) {
  await world.reset();let state=initial();
  for(const type of events) {
    state=transition(cardMachine,state,{type})[0];
    await world.apply(type);
    const actual=cardMachine.resolveState({value:cardFactsToStateValue(await world.facts())});
    expect(actual.value,`after ${events.slice(0,events.indexOf(type)+1).join(" → ")}`).toEqual(state.value);
  }
  return state;
}
it("판을 채운 순서에 따른 카드 장 기억을 두 경로 모두 대조한다",async()=>{
  const first=await run(["CREATE_TODO","PAS_APPEARS","HUMAN_MOVE_noReport","BOARD_FULL"]);
  expect(first.matches({cardEntry:"present"})).toBe(true);
  const second=await run(["CREATE_TODO","PAS_APPEARS","BOARD_FULL","HUMAN_MOVE_noReport"]);
  expect(second.matches({cardEntry:"none"})).toBe(true);
},60000);
it("질문 장 구멍과 늦은 답의 두 문을 대조한다",async()=>{
  await run(["CREATE_TODO","ASSIGN_SESSION","PAS_APPEARS","BOARD_FULL","ASK_OWNER","BOARD_ROOM"]);
  await run(["CREATE_TODO","ASSIGN_SESSION","PAS_APPEARS","ASK_OWNER","HUMAN_MOVE_done","HUMAN_MOVE_running"]);
  await run(["CREATE_TODO","ASSIGN_SESSION","PAS_APPEARS","ASK_OWNER","HUMAN_MOVE_done","ANSWER_DETAIL"]);
},60000);
it("담당이 바뀐 한도 막힘에서 살아 있는 새 담당으로 바로 재개되는 길을 대조한다",async()=>{
  await run(["CREATE_TODO","ASSIGN_SESSION","HUMAN_MOVE_running","SERVER_SHORT_LIMIT","REPLACE_LIVE","SERVER_LIVE_RESUME"]);
  await run(["CREATE_TODO","ASSIGN_SESSION","HUMAN_MOVE_running","SERVER_SHORT_LIMIT","REPLACE_LIMITED","SERVER_LIMIT_RELAUNCH"]);
},60000);
it("철회할 담당 없는 질문을 실제 서비스와 대조한다",async()=>{
  const state=await run(["CREATE_TODO","ASK_OTHER"]);
  expect(cardMachine.getTransitionData(state,{type:"WITHDRAW"})).toHaveLength(0);
  await expect(world.apply("WITHDRAW")).rejects.toMatchObject({statusCode:403});
},60000);
it("끝난 카드의 감독 판 답을 거절하는 것도 기계와 같다",async()=>{
  const state=await run(["CREATE_TODO","ASSIGN_SESSION","PAS_APPEARS","ASK_OWNER","HUMAN_MOVE_done"]);
  expect(cardMachine.getTransitionData(state,{type:"ANSWER_BOARD"})).toHaveLength(0);
  await expect(world.apply("ANSWER_BOARD")).rejects.toMatchObject({statusCode:409});
},60000);

it("기계에서 뽑은 정의별 전이 경로를 서비스에 넣는다",async()=>{
  const inventory=cardContrastPaths();
  const covered=new Set<string>();
  const failures:string[]=[];
  for(const path of inventory.paths) {
    let events=[...path.events];
    // MORE is an input fact about the chosen question, not a question lifecycle
    // in the machine. Supply two real questions through two modeled ASK events.
    if(events.some(e=>e==="ANSWER_MORE"||e==="WITHDRAW_MORE")) {
      const ask=events.findIndex(e=>e==="ASK_OWNER"||e==="ASK_OTHER");
      if(ask>=0)events.splice(ask,0,events[ask]!);
    }
    try {
      await world.reset();let state=initial();
      for(const type of events) {
        const ids=transitionIds(state,{type});
        const expected=transition(cardMachine,state,{type})[0];
        await world.apply(type);
        const actual=cardMachine.resolveState({value:cardFactsToStateValue(await world.facts())});
        expect(actual.value,`${events.join(" → ")} at ${type}`).toEqual(expected.value);
        ids.forEach(id=>covered.add(id));state=expected;
      }
    }catch(error){failures.push(`${events.join(" → ")}: ${String(error)}; actual=${JSON.stringify((error as {actual?:unknown}).actual)} expected=${JSON.stringify((error as {expected?:unknown}).expected)}`);}
  }
  const missing=inventory.definitions.filter(id=>!covered.has(id));
  console.log(JSON.stringify({paths:inventory.paths.length,definitions:inventory.definitions.length,covered:covered.size,missing,failures},null,2));
  expect(failures).toEqual([]);
  expect(missing).toEqual([]);
},180000);
