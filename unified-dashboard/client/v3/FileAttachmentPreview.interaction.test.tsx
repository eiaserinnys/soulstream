/** @vitest-environment jsdom */
import {act,StrictMode} from "react";
import {createRoot} from "react-dom/client";
import {expect,it,vi} from "vitest";
import {FileAttachmentPreview} from "@seosoyoung/soul-ui";

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
