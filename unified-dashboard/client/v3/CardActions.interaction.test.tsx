/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCardStore } from "@seosoyoung/soul-ui/cards/card-store";
import type { CardRow } from "@seosoyoung/soul-ui/cards/card-types";
import { CardActions, CardStatusChip } from "./CardActions";
import { CardRow as CardRowView } from "./CardRow";
import { useCardNavigation } from "./card-navigation";

const card=(status:CardRow["status"]):CardRow=>({id:"c",title:"카드 제목",folderId:"f",status,version:7,blockedKind:null,updatedAt:"2026-09-30"} as CardRow);
describe("display-only card status and completion action",()=>{
 (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT=true;
 let container:HTMLDivElement,root:Root;
 const mutate=vi.fn(),loadCard=vi.fn();
 beforeEach(()=>{container=document.createElement("div");document.body.append(container);root=createRoot(container);mutate.mockReset().mockResolvedValue({});loadCard.mockReset().mockResolvedValue({});useCardStore.setState({mutate,loadCard});});
 afterEach(async()=>{await act(()=>root.unmount());container.remove();useCardStore.getState().reset();vi.restoreAllMocks();});
 async function click(el:HTMLElement){await act(async()=>{el.click();});}
 it.each(["todo","queued","blocked","running","review","done","cancelled"] as const)("shows %s as a word without a status control",async status=>{
  await act(()=>root.render(<CardStatusChip card={card(status)}/>));
  const word=container.querySelector('.v3-status-chip')!;
  expect(word.tagName).toBe("SPAN");expect(word.textContent?.length).toBeGreaterThan(0);
  expect(container.querySelector('button,[role="menu"],[aria-haspopup]')).toBeNull();
  await click(word as HTMLElement);expect(mutate).not.toHaveBeenCalled();expect(loadCard).not.toHaveBeenCalled();
 });
 it.each(["todo","queued","blocked","running","done","cancelled"] as const)("has no action outside review (%s)",async status=>{
  const c:CardRow={...card(status),blockedKind:status==="blocked"?"question":null};
  await act(()=>root.render(<CardRowView card={c}/>));
  expect(container.querySelector('.v3-card-actions button')).toBeNull();
  expect(container.querySelector('[aria-label="답하기"]')).toBeNull();
 });
 it("completes a review card with its current version",async()=>{
  await act(()=>root.render(<CardActions card={card("review")}/>));
  const action=container.querySelector<HTMLButtonElement>('button[aria-label="완료"]')!;
  expect(container.querySelectorAll('button')).toHaveLength(1);await click(action);
  expect(mutate).toHaveBeenCalledWith("c","/status",{status:"done",expectedVersion:7});
 });
 it.each([false,true])("opens the whole row, including its display-only status word (folder metadata=%s)",async folderLabel=>{
  const open=vi.fn();useCardNavigation.setState({open});
  await act(()=>root.render(<CardRowView card={card("running")} folderLabel={folderLabel?"폴더":undefined}/>));
  await click(container.querySelector('.v3-card-status--running')! as HTMLElement);expect(open).toHaveBeenCalledWith("c","overlay");expect(mutate).not.toHaveBeenCalled();
  await click(container.querySelector('[aria-label="카드 카드 제목 열기"]')!);expect(open).toHaveBeenCalledWith("c","overlay");
 });
});
it("uses the same row structure for today and folder metadata, with one review action",()=>{
 const c=card("review");
 const today=renderToStaticMarkup(<CardRowView card={c} folderLabel="폴더"/>),folder=renderToStaticMarkup(<CardRowView card={c}/>);
 expect(today.match(/class="[^"]+"/g)).toEqual(folder.match(/class="[^"]+"/g));
 expect(today).not.toContain("v3-card-row--today");expect(today).not.toContain('aria-label="반려"');
});
