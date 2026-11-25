/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { CardDispatchTab } from "./CardDispatchTab";
import type { cardRequest } from "@seosoyoung/soul-ui/cards/card-api";
vi.mock("./CardOrchestrationSettingsForm",()=>({CardOrchestrationSettingsForm:()=>null}));

it("선행 설정을 읽고 두 스위치와 동시 실행 상한을 함께 저장한다",async()=>{
 (globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
 vi.stubGlobal("PointerEvent",MouseEvent);
 const settings={version:3,nodeConcurrency:{default:2},reviewMeetsDependency:false,startReleasedDependents:false};
 const api=vi.fn().mockResolvedValue({settings});
 const element=document.createElement("div");document.body.append(element);const root=createRoot(element);
 try {
  await act(async()=>{root.render(<CardDispatchTab api={api as typeof cardRequest}/>);await new Promise(done=>setTimeout(done,0));});
  const first=element.querySelector<HTMLButtonElement>('[role="switch"][aria-label="검수 대기도 끝난 것으로 친다"]')!;
  const second=element.querySelector<HTMLButtonElement>('[role="switch"][aria-label="풀린 카드를 바로 시작한다"]')!;
  await act(()=>{first.click();second.click();});
  await act(async()=>{element.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();await new Promise(done=>setTimeout(done,0));});
  expect(api).toHaveBeenLastCalledWith("/api/settings/card-dispatch","PUT",{expectedVersion:3,nodeConcurrency:{default:2},reviewMeetsDependency:true,startReleasedDependents:true});
 } finally {await act(()=>root.unmount());element.remove();vi.unstubAllGlobals();}
});
