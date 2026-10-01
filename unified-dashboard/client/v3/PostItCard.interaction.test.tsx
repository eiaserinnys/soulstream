// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useCardStore } from "@seosoyoung/soul-ui/cards/card-store";
import { useCardNavigation } from "./card-navigation";
import { PostItCard } from "./PostItCard";
import { reviewCard } from "./components-review-fixtures";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT:boolean }).IS_REACT_ACT_ENVIRONMENT=true;
let element:HTMLDivElement,root:Root;
const original = { ...useCardStore.getState() };
const originalOpen = useCardNavigation.getState().open;
beforeEach(() => { element=document.createElement("div");document.body.append(element);root=createRoot(element); });
afterEach(async () => { await act(()=>root.unmount());element.remove();useCardStore.setState(original);useCardNavigation.setState({open:originalOpen}); });

it("opens the whole card and never fetches per-card detail on list mount", async () => {
  const open=vi.fn(),loadCard=vi.fn();
  useCardStore.setState({loadCard});useCardNavigation.setState({open});
  await act(()=>root.render(<PostItCard card={{...reviewCard,latestActivity:{kind:"report",format:"html",body:"<p>운영 본문</p>",createdAt:reviewCard.createdAt}}}/>));
  expect(loadCard).not.toHaveBeenCalled();expect(element.textContent).toContain("운영 본문");
  await act(()=>element.querySelector<HTMLButtonElement>(".v3-postit-open")!.click());
  expect(open).toHaveBeenCalledWith(reviewCard.id,"overlay");
});

it("keeps the review action independent, pending-disabled, and retryable after failure", async () => {
  const open=vi.fn();let reject!: (error:Error)=>void;
  const mutate=vi.fn().mockReturnValueOnce(new Promise((_,fail)=>{reject=fail;})).mockResolvedValue({});
  useCardStore.setState({mutate});useCardNavigation.setState({open});
  await act(()=>root.render(<PostItCard card={{...reviewCard,status:"review"}}/>));
  const button=element.querySelector<HTMLButtonElement>('button[aria-label="완료"]')!;
  await act(()=>button.click());expect(button.disabled).toBe(true);expect(open).not.toHaveBeenCalled();
  expect(mutate).toHaveBeenCalledWith(reviewCard.id,"/status",{status:"done",expectedVersion:reviewCard.version});
  await act(async()=>{reject(new Error("저장 실패"));await Promise.resolve();});
  expect(button.disabled).toBe(false);
  await act(async()=>{button.click();await Promise.resolve();});expect(mutate).toHaveBeenCalledTimes(2);
});
