import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { CARD_EVENTS, EVENT_SOURCES, STATUS_DECISIONS } from "../src/cards/state/card_machine_events.js";
import { cardMachine } from "../src/cards/state/card_machine.js";

it("상태를 정하는 16곳과 사건의 원문 파일이 존재한다",async()=>{
  expect(Object.keys(STATUS_DECISIONS)).toHaveLength(16);
  for(const events of Object.values(STATUS_DECISIONS)) for(const type of events) expect(EVENT_SOURCES[type]?.length).toBeGreaterThan(0);
  for(const sources of Object.values(EVENT_SOURCES))for(const locator of sources) {
    const file=locator.split("#")[0]!;
    expect((await readFile(new URL(`../src/${file}`,import.meta.url),"utf8")).length).toBeGreaterThan(0);
  }
  const visit=(node:typeof cardMachine.root):string[]=>[...Object.keys(node.on),...Object.values(node.states).flatMap(visit)];
  expect(new Set(visit(cardMachine.root))).toEqual(new Set(CARD_EVENTS.map(e=>e.type)));
});

it("판 사실의 숫자는 이 카드의 장을 뺀 세 단계로만 옮긴다",async()=>{
  const {cardFactsToStateValue}=await import("../src/cards/state/card_machine_facts.js");
  const value=(boardEntryCount:number,cardEntryCount:number,questionEntryCount:number)=>cardMachine.resolveState({value:cardFactsToStateValue({status:"running",assignee:"none",supervised:true,boardEntryCount,cardEntryCount,questionEntryCount})}).value;
  expect(value(12,1,0)).toMatchObject({pasBoard:{available:"one"}});
  expect(value(12,0,1)).toMatchObject({pasBoard:{available:"one"}});
  expect(value(12,0,0)).toMatchObject({pasBoard:{available:"full"}});
  expect(value(10,0,0)).toMatchObject({pasBoard:{available:"room"}});
  expect(value(0,0,0)).toMatchObject({pasBoard:{available:"room"}});
});
