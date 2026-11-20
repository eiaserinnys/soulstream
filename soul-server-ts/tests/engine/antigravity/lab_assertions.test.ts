import { expect, it } from "vitest";
import { rawStepUsage, assertTurnUsage, pairedToolNames } from "../../lab/antigravity_assertions.js";
import type { AntigravityEvent } from "../../../src/engine/antigravity/events.js";

it("lab detects incorrect arithmetic, missing/duplicate terminals and mismatched tool identity", () => {
  const event: AntigravityEvent = { event:"step_update",step_update:{conversation_id:"id",step_index:0,state:"DONE",step_type:"agent_response",usage:{input_tokens:7,cache_read_tokens:11,output_tokens:13,thinking_tokens:5}} };
  const usage=rawStepUsage([event,event,{event:"result",result:{status:"SUCCESS",usage:{input_tokens:99999}}}]);
  expect(usage).toEqual({input_tokens:18,cached_input_tokens:11,output_tokens:13,reasoning_output_tokens:5});
  expect(()=>assertTurnUsage([{type:"complete",usage}] as Parameters<typeof assertTurnUsage>[0],usage)).not.toThrow();
  expect(()=>assertTurnUsage([{type:"complete",usage:{...usage,input_tokens:7}}] as Parameters<typeof assertTurnUsage>[0],usage)).toThrow();
  expect(()=>assertTurnUsage([{type:"complete",usage,model:"wrong"}] as Parameters<typeof assertTurnUsage>[0],usage,"expected")).toThrow();
  expect(()=>assertTurnUsage([],usage)).toThrow();
  expect(()=>assertTurnUsage([{type:"complete",usage},{type:"complete",usage}] as Parameters<typeof assertTurnUsage>[0],usage)).toThrow();
  expect(()=>pairedToolNames([{type:"tool_start",tool_use_id:"a",tool_name:"probe"},{type:"tool_result",tool_use_id:"a"}] as Parameters<typeof pairedToolNames>[0])).not.toThrow();
  expect(()=>pairedToolNames([{type:"tool_start",tool_use_id:"a",tool_name:"probe"},{type:"tool_result",tool_use_id:"b"}] as Parameters<typeof pairedToolNames>[0])).toThrow();
});
