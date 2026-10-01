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

it("inherits Enter newline and Ctrl/Cmd+Enter submission from ChatInputEditor", async () => {
  localStorage.setItem("cards-p1-handoff",JSON.stringify({folderId:"f",nodeId:"n",agentId:"a",modelPreset:"sol"}));
  const container=document.createElement("div");document.body.append(container);const root=createRoot(container);
  try {
    flushSync(()=>root.render(createElement(CardHandoff,{folders:[]})));
    const textbox=container.querySelector("textarea")!;
    expect(textbox.rows).toBe(1);
    expect(container.querySelector('button[title="Attach files"]')).not.toBeNull();
    // Native textarea events, as in the existing editor keyboard tests.
    const edit=(text:string)=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")!.set!.call(textbox,text);flushSync(()=>textbox.dispatchEvent(new Event("input",{bubbles:true})));};
    const key=(options:KeyboardEventInit={})=>{const event=new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true,...options});flushSync(()=>textbox.dispatchEvent(event));return event;};
    edit("첫 줄");
    expect(key().defaultPrevented).toBe(false);expect(sessionCreate).not.toHaveBeenCalled();
    expect(key({shiftKey:true}).defaultPrevented).toBe(false);
    expect(container.querySelector("form")).toBeNull();
    expect(key({ctrlKey:true}).defaultPrevented).toBe(true);
    await vi.waitFor(()=>expect(sessionCreate).toHaveBeenCalledTimes(1));
    await vi.waitFor(()=>expect(textbox.value).toBe(""));
    edit("다음 줄");expect(key({metaKey:true}).defaultPrevented).toBe(true);
    await vi.waitFor(()=>expect(sessionCreate).toHaveBeenCalledTimes(2));
  } finally {flushSync(()=>root.unmount());}
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
