/** @vitest-environment jsdom */
import { createElement, type HTMLAttributes } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { CardHandoff } from "./CardHandoff";

vi.mock("@seosoyoung/soul-ui", () => ({
  DashboardIconCap: ({ label, ...props }: HTMLAttributes<HTMLButtonElement> & {label: string}) => createElement("button", {...props,"aria-label":label}),
  Button: (props: HTMLAttributes<HTMLButtonElement>) => createElement("button", props),
  appendAttachmentPathNotes:(text:string)=>text,
  useDashboardStore: Object.assign(()=>null,{getState:()=>({addOptimisticSession:()=>undefined})}),
  Input: (props: HTMLAttributes<HTMLInputElement>) => createElement("input", props),
  Popover: ({ children }: HTMLAttributes<HTMLDivElement>) => children,
  PopoverTrigger: (props: HTMLAttributes<HTMLButtonElement>) => createElement("button", props),
  PopoverPopup: ({ children }: HTMLAttributes<HTMLDivElement>) => children,
}));
vi.mock("@seosoyoung/soul-ui/components/LiquidGlassCard", () => ({LiquidGlassCard: ({webglSurface, ...props}: HTMLAttributes<HTMLDivElement> & {webglSurface: boolean}) => createElement("div", props)}));
vi.mock("@seosoyoung/soul-ui/components/chat/ChatInputEditor", () => ({ChatSendButton: ({label,onSend,disabled}: {label:string;onSend():void;disabled:boolean})=>createElement("button",{"aria-label":label,onClick:onSend,disabled})}));
vi.mock("./CardExecutionPicker", () => ({ CardExecutionPicker: () => null }));
const sessionCreate=vi.hoisted(()=>vi.fn().mockResolvedValue({agentSessionId:"new"}));
vi.mock("../lib/session-create",()=>({createDashboardSession:sessionCreate}));
vi.mock("@tanstack/react-query",()=>({useQueryClient:()=>({})}));
const uploadFiles=vi.hoisted(()=>({files:[] as Array<{id:string;file:File;path:string;status:string}>}));
vi.mock("@seosoyoung/soul-ui/hooks/useFileUpload",()=>({useFileUpload:()=>({...uploadFiles,isUploading:false,addFiles:vi.fn(),removeFile:vi.fn(),resetLocal:vi.fn()})}));
vi.mock("./folder-workspace-page-api",()=>({fetchPageSessionDefaults:vi.fn().mockResolvedValue({nodeId:"other",agentId:"a",modelPreset:"sol"})}));
vi.mock("./FolderPicker", () => ({ FolderPicker: ({folders,onSelect}:any) => createElement("button",{onClick:()=>onSelect(folders[0]),type:"button"},"테스트 폴더") }));
vi.mock("./use-folder-picker-stars", () => ({ useFolderPickerStars: () => ({ folderIds: [] }) }));
afterEach(() => { document.body.replaceChildren(); localStorage.clear(); uploadFiles.files=[]; sessionCreate.mockClear(); });

it("submits with Enter, and preserves Shift+Enter and Korean composition for editing", () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    flushSync(() => root.render(createElement(CardHandoff, { folders: [] })));
    const textbox = container.querySelector("textarea");
    expect(textbox, "handoff must accept multiline requests").not.toBeNull();
    expect(textbox!.rows, "starts with three lines").toBe(3);
    expect(container.querySelectorAll("select")).toHaveLength(0);
    expect(container.querySelector('button[aria-label="세션 시작"]')).not.toBeNull();
    expect(container.querySelector("button[aria-label=첨부]")).not.toBeNull();
    const submit = vi.fn();
    textbox!.form!.requestSubmit = submit;
    const key = (options: KeyboardEventInit) => {
      const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...options });
      textbox!.dispatchEvent(event);
      return event;
    };
    expect(key({ shiftKey: true }).defaultPrevented).toBe(false);
    expect(key({ isComposing: true }).defaultPrevented).toBe(false);
    expect(submit).not.toHaveBeenCalled();
    expect(key({}).defaultPrevented).toBe(true);
    expect(submit).toHaveBeenCalledOnce();
  } finally {
    flushSync(() => root.unmount());
  }
});

it("creates a session with the selected folder and execution fields, without creating a card", async () => {
 localStorage.setItem("cards-p1-handoff",JSON.stringify({folderId:"f",nodeId:"n",agentId:"a",modelPreset:"sol"}));
 const container=document.createElement("div");document.body.append(container);const root=createRoot(container);
 flushSync(()=>root.render(createElement(CardHandoff,{folders:[]})));
 const textbox=container.querySelector("textarea")!;
 const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")!.set!;
 setter.call(textbox,"첫 메시지");
 flushSync(()=>textbox.dispatchEvent(new Event("input",{bubbles:true})));
 flushSync(()=>container.querySelector<HTMLButtonElement>('button[aria-label="세션 시작"]')!.click());
 await vi.waitFor(()=>expect(sessionCreate).toHaveBeenCalledWith(expect.objectContaining({folderId:"f",nodeId:"n",agentId:"a",modelPreset:"sol",initialInstruction:"첫 메시지"})));
 flushSync(()=>root.unmount());
});

it("keeps uploaded attachments on their original node when a folder has another default node",async()=>{
 localStorage.setItem("cards-p1-handoff",JSON.stringify({folderId:"f",nodeId:"n",agentId:"a",modelPreset:"sol"}));
 uploadFiles.files=[{id:"file",file:new File(["image"],"image.png"),path:"/n/image.png",status:"done"}];
 const container=document.createElement("div");document.body.append(container);const root=createRoot(container);
 flushSync(()=>root.render(createElement(CardHandoff,{folders:[{id:"next",name:"다음 폴더",projectPageId:"page"}] as any})));
 flushSync(()=>Array.from(container.querySelectorAll("button")).find(b=>b.textContent==="테스트 폴더")!.click());
 await vi.waitFor(()=>expect(container.querySelector('[role="alert"]')?.textContent).toContain("첨부"));
 expect(JSON.parse(localStorage.getItem("cards-p1-handoff")!)).toMatchObject({folderId:"next",nodeId:"n"});
 flushSync(()=>root.unmount());
});
