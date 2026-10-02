import { describe, expect, it, vi } from "vitest";
import { performCardTransition } from "./card-status-coordinator";
import { reviewDetail } from "./components-review-fixtures";

describe("shared card transition contract", () => {
 it("loads the current version before a drop/menu mutation and awaits persistence", async () => {
  const latest = {...reviewDetail,card:{...reviewDetail.card,status:"todo" as const,version:19},questions:[]};
  const load=vi.fn().mockResolvedValue(latest), change=vi.fn().mockResolvedValue(undefined);
  await performCardTransition({pending:false,load,change},"queued");
  expect(load).toHaveBeenCalledTimes(1);expect(change).toHaveBeenCalledWith(latest.card,"queued",undefined);
 });
 it("allows archived completed cards to reopen or block without reports or reasons",async()=>{
  const detail={...reviewDetail,reports:[],card:{...reviewDetail.card,status:"done" as const,archived:true}};
  const change=vi.fn().mockResolvedValue(undefined),control={pending:false,load:vi.fn().mockResolvedValue(detail),change};
  await performCardTransition(control,"blocked");await performCardTransition(control,"running");await performCardTransition(control,"review");
  expect(change).toHaveBeenCalledTimes(3);
 });
 it.each(["todo","queued","running","review","done","cancelled"] as const)("allows %s despite an unanswered question",async status=>{
  const latest={...reviewDetail,card:{...reviewDetail.card,status:"blocked" as const,blockedKind:"question" as const},questions:[{id:"q",text:"질문",answer:null,options:null,askedAt:"",answeredAt:null}]};
  const change=vi.fn().mockResolvedValue(undefined);
  await performCardTransition({pending:false,load:vi.fn().mockResolvedValue(latest),change},status);
  expect(change).toHaveBeenCalledWith(latest.card,status,undefined);
 });
 it("propagates persistence failures",async()=>{
  const control={pending:false,load:vi.fn().mockResolvedValue({...reviewDetail,questions:[]}),change:vi.fn().mockRejectedValue(new Error("version conflict"))};
  await expect(performCardTransition(control,"blocked")).rejects.toThrow("version conflict");
  await expect(performCardTransition(control,"done")).rejects.toThrow("version conflict");
 });
});
