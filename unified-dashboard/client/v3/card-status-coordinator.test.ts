import { describe, expect, it, vi } from "vitest";
import { cardTransitionError, performCardTransition } from "./card-status-coordinator";
import { reviewDetail } from "./components-review-fixtures";

describe("shared card transition contract", () => {
 it("loads the current version before a drop/menu mutation and awaits persistence", async () => {
  const latest = {...reviewDetail,card:{...reviewDetail.card,status:"todo" as const,version:19},questions:[]};
  const load=vi.fn().mockResolvedValue(latest), change=vi.fn().mockResolvedValue(undefined);
  await performCardTransition({pending:false,load,change},"queued");
  expect(load).toHaveBeenCalledTimes(1);expect(change).toHaveBeenCalledWith(latest.card,"queued",undefined);
 });
 it("gates reports, reason and the nonselectable blocked lane", () => {
  const review={...reviewDetail,card:{...reviewDetail.card,status:"review" as const},questions:[]};
  expect(cardTransitionError(review,"running")).toContain("사유");
  expect(cardTransitionError(review,"running","수정 요청")).toBeNull();
  expect(cardTransitionError({...review,reports:[]},"review")).toContain("보고");
  expect(cardTransitionError(review,"blocked")).toContain("옮길 수 없습니다");
 });
 it.each(["todo","queued","running","review","done","cancelled"] as const)("allows %s despite an unanswered question",async status=>{
  const latest={...reviewDetail,card:{...reviewDetail.card,status:"blocked" as const,blockedKind:"question" as const},questions:[{id:"q",text:"질문",answer:null,options:null,askedAt:"",answeredAt:null}]};
  const change=vi.fn().mockResolvedValue(undefined);
  expect(cardTransitionError(latest,status)).toBeNull();
  await performCardTransition({pending:false,load:vi.fn().mockResolvedValue(latest),change},status);
  expect(change).toHaveBeenCalledWith(latest.card,status,undefined);
 });
 it("rejects invalid transitions without writing and propagates persistence failures",async()=>{
  const control={pending:false,load:vi.fn().mockResolvedValue({...reviewDetail,questions:[]}),change:vi.fn().mockRejectedValue(new Error("version conflict"))};
  await expect(performCardTransition(control,"blocked")).rejects.toThrow("옮길 수 없습니다");expect(control.change).not.toHaveBeenCalled();
  await expect(performCardTransition(control,"done")).rejects.toThrow("version conflict");
 });
});
