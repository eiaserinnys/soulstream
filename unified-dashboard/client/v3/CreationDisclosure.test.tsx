/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { CreationDisclosure } from "./CreationDisclosure";
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
it("forces an invalid selection open and keeps its controls visible after correction",async()=>{
 const host=document.createElement('div'), root=createRoot(host);document.body.append(host);
 const show=(invalid:boolean)=><CreationDisclosure title="실행 환경" summary="모델" invalid={invalid}><input aria-label="모델"/></CreationDisclosure>;
 try {
  await act(()=>root.render(show(false)));expect(host.querySelector('details')!.open).toBe(false);
  await act(()=>root.render(show(true)));expect(host.querySelector('details')!.open).toBe(true);
  const event=new MouseEvent('click',{bubbles:true,cancelable:true});
  await act(()=>host.querySelector('summary')!.dispatchEvent(event));expect(event.defaultPrevented).toBe(true);
  await act(()=>root.render(show(false)));expect(host.querySelector('details')!.open).toBe(true);
  await act(()=>{host.querySelector('details')!.open=false;host.querySelector('details')!.dispatchEvent(new Event('toggle',{bubbles:true}));});
  expect(host.querySelector('details')!.open).toBe(false);
 }finally{await act(()=>root.unmount());host.remove();}
});
