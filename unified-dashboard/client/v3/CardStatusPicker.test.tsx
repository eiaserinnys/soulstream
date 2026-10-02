// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CardDetail } from "@seosoyoung/soul-ui/cards/card-types";
import { CardStatusPicker } from "./CardStatusPicker";
import { reviewCard } from "./components-review-fixtures";

(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let element:HTMLDivElement,root:Root;
const detail=():CardDetail=>({card:{...reviewCard,status:"review",version:7},reports:[{id:"report",title:"보고",body:"보고",format:"markdown",createdAt:"",sessionId:null}],questions:[],sessions:[]});
beforeEach(()=>{element=document.createElement("div");document.body.append(element);root=createRoot(element);});
afterEach(async()=>{await act(()=>root.unmount());element.remove();});
const button=(label:string)=>[...document.querySelectorAll<HTMLButtonElement>("button")].find(x=>x.getAttribute("aria-label")===label || x.getAttribute("data-slot")==="button" && x.textContent===label)!;
const click=async(label:string)=>act(async()=>{button(label).click();await new Promise(done=>setTimeout(done,20));});
async function render(load=vi.fn().mockResolvedValue(detail()),change=vi.fn().mockResolvedValue(undefined),onOpen=vi.fn()) {
 await act(()=>root.render(<CardStatusPicker card={reviewCard} control={{load,change,pending:false}} onOpen={onOpen}/>));
 return {load,change,onOpen};
}
it("loads only on explicit opens, gates missing reports, and does not mutate the current status",async()=>{
 const d=detail();d.reports=[];const c=await render(vi.fn().mockResolvedValue(d));
 expect(c.load).not.toHaveBeenCalled();await click("카드 상태 변경");expect(c.load).toHaveBeenCalledTimes(1);
 expect(button("검수 대기").disabled).toBe(true);expect(document.body.textContent).not.toContain("보고가 필요합니다");expect(document.body.textContent).not.toContain("대기: 담당 에이전트");
 await click("드래프트");expect(c.change).toHaveBeenCalledWith(d.card,"todo",undefined);expect(c.onOpen).not.toHaveBeenCalled();
});
it("allows changes with unanswered questions and still requests a review restart reason",async()=>{
 const d=detail();d.questions=[{id:"q",text:"질문",options:null,answer:null,askedAt:"",answeredAt:null}];
 const c=await render(vi.fn().mockResolvedValue(d));await click("카드 상태 변경");
 for(const label of ["드래프트","대기","실행 중","검수 대기","완료","취소"])expect(button(label).disabled).toBe(false);
 expect(document.body.textContent).not.toContain("질문에 답한 뒤 변경할 수 있습니다");
 await click("실행 중");expect(button("확인").disabled).toBe(true);expect(c.change).not.toHaveBeenCalled();
 await click("취소");await click("완료");expect(c.change).toHaveBeenCalledWith(d.card,"done",undefined);expect(c.onOpen).not.toHaveBeenCalled();
});
it("requires a reason, cancels without writes, and preserves the draft on failure until explicit refresh",async()=>{
 const change=vi.fn().mockRejectedValue(new Error("version conflict")),c=await render(undefined,change);
 await click("카드 상태 변경");await click("실행 중");expect(button("확인").disabled).toBe(true);
 await click("취소");expect(change).not.toHaveBeenCalled();await click("실행 중");
 const input=document.querySelector<HTMLInputElement>('input[aria-label="다시 실행할 사유"]')!;
 await act(()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(input,"수정 요청");input.dispatchEvent(new Event("input",{bubbles:true}));});
 await click("확인");expect(change).toHaveBeenCalledWith(expect.objectContaining({version:7}),"running","수정 요청");
 expect(input.value).toBe("수정 요청");expect(document.body.textContent).toContain("version conflict");expect(button("확인").disabled).toBe(true);
 await click("갱신 후 재시도");expect(c.load).toHaveBeenCalledTimes(2);expect(input.value).toBe("수정 요청");
});
it("keeps loading and failures unselectable, ignores closed late responses, and refreshes on reopening",async()=>{
 let resolve!:(d:CardDetail)=>void;const load=vi.fn().mockReturnValueOnce(new Promise<CardDetail>(done=>{resolve=done;})).mockRejectedValueOnce(new Error("읽기 실패")).mockResolvedValue(detail());
 const c=await render(load);await click("카드 상태 변경");expect(button("완료").disabled).toBe(true);
 await click("카드 상태 변경");await act(()=>resolve(detail()));expect(document.querySelector('[data-card-status-picker]')).toBeNull();
 await click("카드 상태 변경");expect(button("완료").disabled).toBe(true);await click("다시 불러오기");expect(load).toHaveBeenCalledTimes(3);
 expect(button("완료").disabled).toBe(false);expect(c.change).not.toHaveBeenCalled();
});
it("keeps the current state unchanged and prevents duplicate writes while pending",async()=>{
 let resolve!:()=>void;const d=detail();d.card.status="todo";const change=vi.fn().mockReturnValue(new Promise<void>(done=>{resolve=done;}));
 const c=await render(vi.fn().mockResolvedValue(d),change);await click("카드 상태 변경");await click("드래프트");expect(change).not.toHaveBeenCalled();
 await click("완료");await click("완료");expect(change).toHaveBeenCalledTimes(1);expect(c.onOpen).not.toHaveBeenCalled();await act(async()=>{resolve();await new Promise(done=>setTimeout(done,20));});
});
