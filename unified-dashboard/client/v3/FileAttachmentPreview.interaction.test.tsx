/** @vitest-environment jsdom */
import {act,StrictMode} from "react";
import {createRoot} from "react-dom/client";
import {expect,it,vi} from "vitest";
import {FileAttachmentPreview} from "@seosoyoung/soul-ui";
import {ChatInput} from "../../../packages/soul-ui/src/components/ChatInput";
import {ChatStoreScopeProvider} from "../../../packages/soul-ui/src/stores/chat-store-scope";
import {createChatSessionStore,useDashboardStore} from "../../../packages/soul-ui/src/stores/dashboard-store";

const chatInputState=vi.hoisted(()=>({
 files:[] as Array<Record<string,unknown>>,
 isUploading:false,
 isReady:true,
 uploadedPaths:[] as string[],
 send:vi.fn(),
 removeFile:vi.fn(),
}));
vi.mock("../../../packages/soul-ui/src/components/chat/useChatInputSend",()=>({useChatInputSend:()=>({
 sending:false,error:null,reset:vi.fn(),send:chatInputState.send,retry:vi.fn(),
})}));
vi.mock("../../../packages/soul-ui/src/hooks/useFileUpload",()=>({useFileUpload:()=>({
 files:chatInputState.files,isUploading:chatInputState.isUploading,isReady:chatInputState.isReady,
 addFiles:vi.fn(),removeFile:chatInputState.removeFile,resetLocal:vi.fn(),restoreUploadedFiles:vi.fn(),uploadedPaths:chatInputState.uploadedPaths,
})}));

it("keeps the visible image URL alive through StrictMode mount cleanup",async()=>{
 (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
 const revoked=new Set<string>();let sequence=0;
 vi.stubGlobal("URL",class extends URL {
  static createObjectURL(){return `blob:preview-${++sequence}`;}
  static revokeObjectURL(url:string){revoked.add(url);}
 });
 const container=document.createElement("div");document.body.append(container);const root=createRoot(container);
 try {
  await act(()=>root.render(<StrictMode><FileAttachmentPreview file={new File(["image"],"image.png",{type:"image/png"})} status="done" onRemove={()=>{}}/></StrictMode>));
  const visibleUrl=container.querySelector("img")!.getAttribute("src")!;
  expect(visibleUrl).toMatch(/^blob:preview-/);
  expect(revoked.has(visibleUrl)).toBe(false);
 }finally{await act(()=>root.unmount());container.remove();vi.unstubAllGlobals();}
});

it("opens a local attachment chip and removes it through separate actions",async()=>{
 (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
 const file=new File(["note"],"긴 파일 이름.pdf",{type:"application/pdf"});
 const onOpen=vi.fn(),onRemove=vi.fn();
 const container=document.createElement("div");document.body.append(container);const root=createRoot(container);
 try {
  await act(()=>root.render(<FileAttachmentPreview variant="chip" file={file} status="done" onOpen={onOpen} onRemove={onRemove}/>));
  const view=container.querySelector<HTMLButtonElement>("[data-chat-attachment-chip-view]")!;
  expect(container.querySelector("[data-chat-attachment-chip]")).not.toBeNull();
  await act(()=>view.click());
  expect(onOpen).toHaveBeenCalledWith(file,view);
  await act(()=>container.querySelector<HTMLButtonElement>('button[aria-label="Remove file"]')!.click());
  expect(onRemove).toHaveBeenCalledOnce();
 }finally{await act(()=>root.unmount());container.remove();}
});

it("uses a preview chip for ready uploads and only enables attachment-only send when ready",async()=>{
 (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
 useDashboardStore.getState().reset();
 const file=new File(["pdf"],"긴 문서 파일 이름.pdf",{type:"application/pdf"});
 chatInputState.files=[{id:"file-a",file,path:"/fixture/image.png",status:"done"}];
 chatInputState.isUploading=false;chatInputState.isReady=true;chatInputState.uploadedPaths=["/fixture/image.png"];
 chatInputState.send.mockClear();chatInputState.removeFile.mockClear();
 const scope=createChatSessionStore("session-1"),container=document.createElement("div");document.body.append(container);const root=createRoot(container);
 const render=()=>root.render(<ChatStoreScopeProvider scope={scope}><ChatInput fileUploadUrl="/fixture/upload"/></ChatStoreScopeProvider>);
 try {
  await act(()=>render());
  expect(container.querySelector("[data-chat-attachment-chip]")).not.toBeNull();
  const view=container.querySelector<HTMLButtonElement>("[data-chat-attachment-chip-view]")!;
  await act(()=>view.click());
  expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
  await act(()=>document.body.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.click());
  chatInputState.removeFile.mockClear();chatInputState.send.mockClear();
  await act(()=>container.querySelector<HTMLButtonElement>('button[aria-label="Remove file"]')!.click());
  expect(chatInputState.removeFile).toHaveBeenCalledWith("file-a");
  expect(chatInputState.send).not.toHaveBeenCalled();
  const sendButton=container.querySelector<HTMLButtonElement>('[data-testid="send-button"]')!;
  expect(sendButton.disabled).toBe(false);
  await act(()=>sendButton.click());
  expect(chatInputState.send).toHaveBeenCalledWith("");

  chatInputState.files=[{id:"file-a",file,path:null,status:"uploading"}];
  chatInputState.isUploading=true;chatInputState.isReady=false;chatInputState.uploadedPaths=[];
  await act(()=>render());
  expect(container.querySelector<HTMLButtonElement>('[data-testid="send-button"]')!.disabled).toBe(true);
  expect(container.querySelector("[data-chat-attachment-chip]")).not.toBeNull();
 }finally{await act(()=>root.unmount());container.remove();}
});
