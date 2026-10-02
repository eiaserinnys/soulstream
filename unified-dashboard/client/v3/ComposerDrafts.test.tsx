/** @vitest-environment jsdom */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useDashboardStore } from "@seosoyoung/soul-ui";
import { CardHandoff } from "./CardHandoff";
import { CardCommentInput } from "./CardCommentInput";

vi.mock("@seosoyoung/soul-ui", async original => ({
  ...await original<typeof import("@seosoyoung/soul-ui")>(),
  Popover: ({children}: {children:ReactNode}) => children,
  PopoverTrigger: (props:React.ComponentProps<"button">) => <button {...props}/>,
  PopoverPopup: ({children}: {children:ReactNode}) => children,
}));
const createSession=vi.hoisted(()=>vi.fn().mockResolvedValue({agentSessionId:"new"}));
vi.mock("../lib/session-create",()=>({createDashboardSession:createSession}));
vi.mock("@tanstack/react-query",()=>({useQueryClient:()=>({})}));
vi.mock("@seosoyoung/soul-ui/hooks/useFileUpload",()=>({useFileUpload:()=>({files:[],isUploading:false,addFiles:vi.fn(),removeFile:vi.fn(),resetLocal:vi.fn()})}));
vi.mock("./FolderPicker",()=>({FolderPicker:({folders,onSelect}:any)=><button onClick={()=>onSelect(folders[0])}>다음 폴더</button>}));
vi.mock("./use-folder-picker-stars",()=>({useFolderPickerStars:()=>({folderIds:[]})}));
vi.mock("./CardExecutionPicker",()=>({CardExecutionPicker:({selection,onChange}:any)=><button onClick={()=>onChange({...selection,nodeId:"next-node"})}>다음 노드</button>}));
const mainKey="composer:main";
const cardKey=(id:string)=>`composer:card-comment:${id}`;
let container:HTMLDivElement,root:Root;
beforeEach(()=>{
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
  localStorage.clear();useDashboardStore.setState({drafts:{}});
  localStorage.setItem("cards-p1-handoff",JSON.stringify({folderId:"f",nodeId:"n",agentId:"a",modelPreset:"sol"}));
  createSession.mockReset().mockResolvedValue({agentSessionId:"new"});
  container=document.createElement("div");document.body.append(container);root=createRoot(container);
});
afterEach(async()=>{await act(()=>root.unmount());container.remove();useDashboardStore.setState({drafts:{}});localStorage.clear();});
const render=async(node:ReactNode)=>{await act(()=>root.render(node));};
const input=()=>container.querySelector<HTMLTextAreaElement>("textarea")!;
// Existing CardDetailPane interaction tests use native value/input events.
const edit=async(text:string)=>{
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")!.set!.call(input(),text);
  await act(()=>input().dispatchEvent(new Event("input",{bubbles:true})));
};
const submit=async()=>{await act(async()=>{container.querySelector<HTMLButtonElement>('[data-testid="send-button"]')!.click();await Promise.resolve();});};
const rehydrate=async()=>{
  const snapshot=localStorage.getItem("soul-dashboard-storage")!;
  await render(null);useDashboardStore.setState({drafts:{}});
  localStorage.setItem("soul-dashboard-storage",snapshot);
  await act(()=>useDashboardStore.persist.rehydrate());
};
const main=()=> <CardHandoff folders={[{id:"next",name:"다음 폴더"}] as any}/>;

it("puts both selection buttons above the composer",async()=>{
  await render(main());
  const controls=container.querySelector(".v3-card-handoff-controls")!;
  const composer=container.querySelector('[data-testid="card-composer"]')!;
  expect(controls.compareDocumentPosition(composer)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(controls.querySelectorAll(".v3-card-handoff-chip")).toHaveLength(2);
});
it("restores the main draft on remount and from persisted storage",async()=>{
  useDashboardStore.getState().setDraft(mainKey,"이전 초안");
  await render(main());expect(input().value).toBe("이전 초안");
  await edit("수정한 초안\n다음 줄");
  expect(useDashboardStore.getState().drafts[mainKey]).toBe("수정한 초안\n다음 줄");
  await render(null);await render(main());expect(input().value).toBe("수정한 초안\n다음 줄");
  await rehydrate();await render(main());expect(input().value).toBe("수정한 초안\n다음 줄");
});
it("keeps one main draft while changing folders and nodes",async()=>{
  await render(main());await edit("선택과 무관한 초안");
  for(const label of ["다음 폴더","다음 노드"]){
    await act(()=>[...container.querySelectorAll("button")].find(b=>b.textContent===label)!.click());
    expect(input().value).toBe("선택과 무관한 초안");
  }
  expect(useDashboardStore.getState().drafts[mainKey]).toBe("선택과 무관한 초안");
});
it("clears the submitted main draft after success and retains it on failure",async()=>{
  await render(main());await edit(" 성공 초안 ");await submit();
  expect(input().value).toBe("");expect(useDashboardStore.getState().drafts[mainKey]).toBeUndefined();
  createSession.mockRejectedValueOnce(new Error("전송 실패"));await edit("실패 초안");await submit();
  expect(input().value).toBe("실패 초안");expect(useDashboardStore.getState().drafts[mainKey]).toBe("실패 초안");
});
it("does not erase a new main draft when an earlier request succeeds",async()=>{
  let finish!:()=>void;createSession.mockImplementationOnce(()=>new Promise<void>(resolve=>{finish=resolve;}));
  await render(main());await edit("전송한 초안");await submit();
  await act(()=>useDashboardStore.getState().setDraft(mainKey,"새로 작성한 초안"));
  await act(async()=>{finish();await Promise.resolve();});
  expect(input().value).toBe("새로 작성한 초안");expect(useDashboardStore.getState().drafts[mainKey]).toBe("새로 작성한 초안");
});
it("isolates card A/B drafts and restores both after remount and rehydration",async()=>{
  const send=vi.fn().mockResolvedValue(true);
  await render(<CardCommentInput cardId="a" pending={false} onSend={send}/>);await edit("A 초안");
  await render(<CardCommentInput cardId="b" pending={false} onSend={send}/>);expect(input().value).toBe("");await edit("B 초안");
  await render(null);await render(<CardCommentInput cardId="a" pending={false} onSend={send}/>);expect(input().value).toBe("A 초안");
  await rehydrate();await render(<CardCommentInput cardId="b" pending={false} onSend={send}/>);expect(input().value).toBe("B 초안");
});
it("clears only a successful card comment, retaining failed text",async()=>{
  const send=vi.fn().mockResolvedValue(false);
  await render(<CardCommentInput cardId="a" pending={false} onSend={send}/>);await edit("커멘트 초안");await submit();
  expect(input().value).toBe("커멘트 초안");expect(useDashboardStore.getState().drafts[cardKey("a")]).toBe("커멘트 초안");
  send.mockResolvedValueOnce(true);await submit();
  expect(input().value).toBe("");expect(useDashboardStore.getState().drafts[cardKey("a")]).toBeUndefined();
});
it("keeps a new card A draft and card B draft when card A submission finishes",async()=>{
  let finish!:(ok:boolean)=>void;const send=vi.fn(()=>new Promise<boolean>(resolve=>{finish=resolve;}));
  await render(<CardCommentInput cardId="a" pending={false} onSend={send}/>);await edit("전송한 A 초안");await submit();
  await act(()=>useDashboardStore.getState().setDraft(cardKey("a"),"새 A 초안"));
  await render(<CardCommentInput cardId="b" pending={false} onSend={send}/>);await edit("B 초안");
  await act(async()=>{finish(true);await Promise.resolve();});
  expect(input().value).toBe("B 초안");expect(useDashboardStore.getState().drafts).toMatchObject({[cardKey("a")]:"새 A 초안",[cardKey("b")]:"B 초안"});
});
