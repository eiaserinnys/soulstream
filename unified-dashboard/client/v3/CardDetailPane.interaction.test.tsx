/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useCardStore } from "@seosoyoung/soul-ui/cards/card-store";
import { CardDetailPane } from "./CardDetailPane";
import type { CardDetail } from "@seosoyoung/soul-ui/cards/card-types";

vi.mock("@seosoyoung/soul-ui", async original => ({
  ...await original<typeof import("@seosoyoung/soul-ui")>(),
  useAuth: () => ({user:null}), useSessionListProvider: () => ({sessions:[],loading:false}),
}));
const card = {id:"inherit",folderId:"f",title:"행 제목",request:"요청 첫 줄\n다음 줄",brief:"",status:"running",blockedKind:null,version:1,createdAt:"2026-10-01",updatedAt:"2026-10-01",nodeId:"node",assigneeSessionId:"owner",assigneeAgentId:"roselin",modelPreset:"sol"} as CardDetail["card"];
const detail:CardDetail = {card,sessions:[],comments:[{id:"c",cardId:card.id,authorKind:"user",authorId:"sample",sessionId:null,kind:"comment",body:"커멘트 본문",createdAt:card.createdAt}],questions:[{id:"q",text:"질문 본문",options:["답변"],answer:"답변 본문",askedAt:card.createdAt,answeredAt:card.createdAt}],reports:[{id:"r",sessionId:null,title:"최신 보고 제목",format:"markdown",body:"첫 줄\n둘째 줄\n셋째 줄\n넷째 줄\n\n![캡처](https://example.test/capture.png)",createdAt:"2026-10-01"}]};
let container:HTMLDivElement,root:Root;
beforeEach(()=>{
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
  container=document.createElement("div");document.body.append(container);root=createRoot(container);
  useCardStore.setState({byId:{inherit:card},details:{inherit:detail},loadCard:vi.fn().mockResolvedValue(detail)});
});
afterEach(async()=>{await act(()=>root.unmount());container.remove();useCardStore.getState().reset();vi.restoreAllMocks();});

const render=async(onClose=vi.fn())=>{await act(()=>root.render(<CardDetailPane cardId="inherit" folders={[]} onClose={onClose} onOpenSession={()=>{}}/>));return onClose;};
const tab=async(name:string)=>{await act(()=>[...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(el=>el.textContent===name)!.click());};
it("starts with conversation only and switches to content without losing the draft",async()=>{
 await render();
 expect(container.querySelector('[data-card-entry="지시"]')).toBeNull();
 expect(container.querySelector('[data-card-entry="보고"]')).toBeNull();
 for(const label of ["커멘트","질문","답"])expect(container.querySelector(`[data-card-entry="${label}"]`)).not.toBeNull();
 const textarea=container.querySelector('textarea')!;
 Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")!.set!.call(textarea,"작성 중");
 await act(()=>textarea.dispatchEvent(new Event("input",{bubbles:true})));
 await tab("내용");
 expect(container.querySelector('[data-card-entry="지시"]')).not.toBeNull();
 expect(container.querySelector('[data-card-entry="보고"]')).not.toBeNull();
 for(const label of ["커멘트","질문","답"])expect(container.querySelector(`[data-card-entry="${label}"]`)).toBeNull();
 expect(textarea.closest('[hidden]')).not.toBeNull();
 await tab("커멘트");
 expect(container.querySelector('textarea')).toBe(textarea);expect(textarea.value).toBe("작성 중");
});
it("closes after successful completion",async()=>{
 useCardStore.setState({byId:{inherit:{...card,status:"review"}},details:{inherit:{...detail,card:{...card,status:"review"}}},mutate:vi.fn().mockResolvedValue(undefined)});
 const close=await render();
 await act(async()=>{container.querySelector<HTMLButtonElement>('[aria-label="완료"]')!.click();await Promise.resolve();});
 expect(useCardStore.getState().mutate).toHaveBeenCalledWith("inherit","/status",{status:"done",expectedVersion:1});
 expect(close).toHaveBeenCalledTimes(1);
});
it("keeps the panel open and shows the store error when completion fails",async()=>{
 useCardStore.setState({byId:{inherit:{...card,status:"review"}},mutate:vi.fn().mockImplementation(async()=>{useCardStore.setState({errors:{inherit:"완료 실패"}});throw new Error("완료 실패");})});
 const close=await render();await act(async()=>{container.querySelector<HTMLButtonElement>('[aria-label="완료"]')!.click();await Promise.resolve();});
 expect(close).not.toHaveBeenCalled();expect(container.querySelector('[role="alert"]')?.textContent).toBe("완료 실패");
});

it("resets the selected tab when a different card opens",async()=>{
 await render();await tab("내용");
 const other={...card,id:"other"};await act(()=>useCardStore.setState({byId:{inherit:card,other},details:{inherit:detail,other:{...detail,card:other}}}));
 await act(()=>root.render(<CardDetailPane cardId="other" folders={[]} onClose={()=>{}} onOpenSession={()=>{}}/>));
 expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("커멘트");
 expect(container.querySelector('[data-card-entry="지시"]')).toBeNull();
});
