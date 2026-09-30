/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCardStore } from "@seosoyoung/soul-ui/cards/card-store";
import type { CardRow } from "@seosoyoung/soul-ui/cards/card-types";
import { CardStatusChip } from "./CardActions";
import { CardRow as CardRowView } from "./CardRow";
import { useCardNavigation } from "./card-navigation";
// Match existing createRoot interaction tests; isolate the menu portal, not mutations.
vi.mock("./V3ContextMenu",()=>({V3ContextMenu:({target,actions,onClose}:any)=>target?<div role="menu">{actions.map((a:any)=><button key={a.label} disabled={a.disabled} onClick={()=>{onClose();a.onSelect();}}>{a.label}</button>)}</div>:null}));
const card=(status:CardRow["status"]):CardRow=>({id:"c",title:"카드 제목",folderId:"f",status,version:7,blockedKind:null} as CardRow);
describe("card status menu",()=>{
 (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT=true;
 let container:HTMLDivElement,root:Root;
 const mutate=vi.fn(),loadCard=vi.fn();
 beforeEach(()=>{container=document.createElement("div");document.body.append(container);root=createRoot(container);mutate.mockReset().mockResolvedValue({});loadCard.mockReset().mockResolvedValue({});useCardStore.setState({mutate,loadCard});});
 afterEach(async()=>{await act(()=>root.unmount());container.remove();useCardStore.getState().reset();vi.restoreAllMocks();});
 async function render(status:CardRow["status"],reports=0){const c=card(status);useCardStore.setState({details:{c:{card:c,reports:Array.from({length:reports},()=>({})) as never,questions:[],sessions:[]}}});await act(()=>root.render(<CardStatusChip card={c}/>));await click(container.querySelector("button")!);}
 async function click(el:HTMLElement){await act(async()=>{el.click();});}
 function menuButton(label:string){return [...container.querySelectorAll<HTMLButtonElement>('[role="menu"] button')].find(b=>b.textContent===label)!;}
 it("lists six states, disables current and reportless review, and omits blocked",async()=>{await render("running");expect(menuButton("실행 중 (현재)").disabled).toBe(true);expect(menuButton("검수 (보고 필요)").disabled).toBe(true);expect(container.querySelectorAll('[role="menu"] button')).toHaveLength(6);expect(container.textContent).not.toContain("막힘");});
 it.each([["todo","실행 중","running"],["running","할 일","todo"],["running","완료","done"],["running","취소","cancelled"]] as const)("changes %s to %s with the version",async(from,label,status)=>{await render(from);await click(menuButton(label));expect(mutate).toHaveBeenCalledWith("c","/status",{status,expectedVersion:7});});
 it("enables review with a report",async()=>{await render("running",1);expect(menuButton("검수").disabled).toBe(false);await click(menuButton("검수"));expect(mutate).toHaveBeenCalledWith("c","/status",{status:"review",expectedVersion:7});});
 it("requires rejection reason when leaving review for running",async()=>{await render("review",1);await click(menuButton("실행 중"));expect(mutate).not.toHaveBeenCalled();expect(document.querySelector('input[aria-label="반려 사유"]')).not.toBeNull();const reject=[...document.querySelectorAll<HTMLButtonElement>("button")].find(b=>b.textContent==="반려")!;expect(reject.disabled).toBe(true);});
 it("shows API rejection messages",async()=>{mutate.mockRejectedValueOnce(new Error("422: 보고가 필요합니다"));await render("todo");await click(menuButton("실행 중"));expect(container.querySelector('[role="alert"]')?.textContent).toContain("422: 보고가 필요합니다");});
 it.each([false,true])("keeps status and open as sibling buttons (today=%s)",async(today)=>{const open=vi.fn();useCardNavigation.setState({open});const c=card("running");await act(()=>root.render(<CardRowView card={c} today={today}/>));const chip=container.querySelector<HTMLButtonElement>('button[aria-label="카드 상태 변경"]');expect(chip).not.toBeNull();expect(chip!.parentElement?.closest("button")).toBeNull();await click(chip!);expect(open).not.toHaveBeenCalled();await click(container.querySelector('[aria-label="카드 카드 제목 열기"]')!);expect(open).toHaveBeenCalledWith("c","inline");});
});
