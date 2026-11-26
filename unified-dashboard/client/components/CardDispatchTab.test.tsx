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

it("라벨 글자를 눌러도 스위치가 바뀌고 보조 문구는 같은 라벨 안에 있다",async()=>{
 (globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
 vi.stubGlobal("PointerEvent",MouseEvent);
 const api=vi.fn().mockResolvedValue({settings:{version:3,nodeConcurrency:{default:2},reviewMeetsDependency:false,startReleasedDependents:false}});
 const element=document.createElement("div");document.body.append(element);const root=createRoot(element);
 try {
  await act(async()=>{root.render(<CardDispatchTab api={api as typeof cardRequest}/>);await new Promise(done=>setTimeout(done,0));});
  const switchOf=(name:string)=>element.querySelector<HTMLButtonElement>(`[role="switch"][aria-label="${name}"]`)!;
  const labelText=(text:string)=>[...element.querySelectorAll<HTMLSpanElement>("label span")].find(span=>span.textContent===text)!;
  expect(switchOf("검수 대기도 끝난 것으로 친다").getAttribute("aria-checked")).toBe("false");
  await act(()=>{labelText("검수 대기도 끝난 것으로 친다").click();});
  expect(switchOf("검수 대기도 끝난 것으로 친다").getAttribute("aria-checked")).toBe("true");
  await act(()=>{labelText("풀린 카드를 바로 시작한다").click();});
  expect(switchOf("풀린 카드를 바로 시작한다").getAttribute("aria-checked")).toBe("true");
  const help=labelText("선행 카드가 끝나면 실행 상한과 대기 순서와 상관없이 서버가 그 카드를 바로 시작한다. 중앙 카드 배정이 켜져 있으면 쓰이지 않는다.");
  expect(help.closest("label")).toBe(switchOf("풀린 카드를 바로 시작한다").closest("label"));
  expect(element.querySelector("label.text-sm")).not.toBeNull();
 } finally {await act(()=>root.unmount());element.remove();vi.unstubAllGlobals();}
});

it("서버 응답에 선행 키가 없으면 둘 다 꺼진 값으로 다루고 저장 본문에 두 키를 늘 싣는다",async()=>{
 (globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
 vi.stubGlobal("PointerEvent",MouseEvent);
 const api=vi.fn().mockResolvedValue({settings:{version:3,nodeConcurrency:{default:2}}});
 const element=document.createElement("div");document.body.append(element);const root=createRoot(element);
 try {
  await act(async()=>{root.render(<CardDispatchTab api={api as typeof cardRequest}/>);await new Promise(done=>setTimeout(done,0));});
  for(const name of ["검수 대기도 끝난 것으로 친다","풀린 카드를 바로 시작한다"])
   expect(element.querySelector(`[role="switch"][aria-label="${name}"]`)!.getAttribute("aria-checked")).toBe("false");
  await act(async()=>{element.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();await new Promise(done=>setTimeout(done,0));});
  expect(api).toHaveBeenLastCalledWith("/api/settings/card-dispatch","PUT",{expectedVersion:3,nodeConcurrency:{default:2},reviewMeetsDependency:false,startReleasedDependents:false});
  expect(element.querySelector('[role="switch"][aria-label="검수 대기도 끝난 것으로 친다"]')!.getAttribute("aria-checked")).toBe("false");
 } finally {await act(()=>root.unmount());element.remove();vi.unstubAllGlobals();}
});

it("설정 조회가 실패하면 로딩을 멈추고 오류 안내와 다시 불러오기를 보이며, 다시 불러오면 입력 칸이 선다",async()=>{
 (globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
 vi.stubGlobal("PointerEvent",MouseEvent);
 const {CardApiError}=await import("@seosoyoung/soul-ui/cards/card-api");
 const settings={version:3,nodeConcurrency:{default:2},reviewMeetsDependency:false,startReleasedDependents:false};
 const api=vi.fn().mockRejectedValueOnce(new CardApiError("카드 요청 실패 (500)",500)).mockResolvedValue({settings});
 const element=document.createElement("div");document.body.append(element);const root=createRoot(element);
 try {
  await act(async()=>{root.render(<CardDispatchTab api={api as typeof cardRequest}/>);await new Promise(done=>setTimeout(done,0));});
  const notice=element.querySelector(".v3-error-notice")!;
  expect(notice.textContent).toContain("카드 실행 설정을 불러오지 못했습니다.");
  expect(notice.querySelector("pre")?.textContent).toContain("카드 요청 실패 (500)");
  expect(element.querySelector('[data-slot="frame-loading"]')).toBeNull();
  expect(element.querySelector('p[role="alert"]')).toBeNull();
  await act(async()=>{notice.querySelector("button")!.click();await new Promise(done=>setTimeout(done,0));});
  expect(element.querySelector(".v3-error-notice")).toBeNull();
  expect(element.querySelector('input[aria-label="기본값 동시 실행 상한"]')).not.toBeNull();
 } finally {await act(()=>root.unmount());element.remove();vi.unstubAllGlobals();}
});
