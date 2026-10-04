/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useDashboardStore, type SessionSummary } from "@seosoyoung/soul-ui";
import { useV3SessionPanelController } from "./use-v3-session-panel-controller";

const cardRequest = vi.hoisted(() => vi.fn());
vi.mock("@seosoyoung/soul-ui/cards/card-api", () => ({ cardRequest }));

const owner:SessionSummary={agentSessionId:"owner",displayName:"담당 세션",status:"completed",eventCount:1,folderId:"folder-1"};
const linked:SessionSummary={agentSessionId:"linked",displayName:"소속 세션",status:"completed",eventCount:1,folderId:"folder-1",cardId:"card-1"};
const folder={folderId:"folder-1"} as never;
const openCard=vi.fn(),clearCard=vi.fn(),selectFolder=vi.fn(async()=>undefined),clearFolder=vi.fn(),setChatOpen=vi.fn(),notify=vi.fn();
let host:HTMLDivElement,root:Root;

function Harness({session}:{session:SessionSummary}){
  const controller=useV3SessionPanelController({api:{} as never,catalog:{sessionList:[session]} as never,currentFolderEntries:[folder],acknowledgedReviewIds:new Set(),
    onSelectFolder:selectFolder,onClearFolder:clearFolder,setChatOpen,notify,openCard,clearCard});
  return <button onClick={()=>void controller.openFeedSession(session)}>select feed row</button>;
}

async function click(session:SessionSummary){await act(()=>root.render(<Harness session={session}/>));await act(()=>host.querySelector("button")!.click());}

beforeEach(()=>{
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  cardRequest.mockReset();openCard.mockReset();clearCard.mockReset();selectFolder.mockClear();clearFolder.mockClear();setChatOpen.mockClear();notify.mockClear();
  useDashboardStore.setState({catalog:null,drafts:{}});
  host=document.createElement("div");document.body.append(host);root=createRoot(host);
});
afterEach(async()=>{await act(()=>root.unmount());host.remove();vi.restoreAllMocks();(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;});

it("opens a session.cardId directly in the card overlay with the clicked session",async()=>{
  await click(linked);
  expect(cardRequest).not.toHaveBeenCalled();
  expect(openCard).toHaveBeenCalledWith("card-1","overlay",null,"linked");
  expect(setChatOpen).toHaveBeenCalledWith(true);
});

it("resolves an assignee card from the authenticated completed-inclusive list",async()=>{
  cardRequest.mockResolvedValue({cards:[{id:"card-1",assigneeSessionId:"owner"}]});
  await click(owner);
  expect(cardRequest).toHaveBeenCalledWith("/api/cards?includeCompleted=true");
  expect(openCard).toHaveBeenCalledWith("card-1","overlay",null,"owner");
});

it("clears an old card before the existing folder path handles a session without a card",async()=>{
  cardRequest.mockResolvedValue({cards:[]});
  await click(owner);
  expect(clearCard).toHaveBeenCalledTimes(1);
  expect(selectFolder).toHaveBeenCalledWith(folder);
  expect(openCard).not.toHaveBeenCalled();
});

it("reports card-list failure without treating it as a no-card session",async()=>{
  cardRequest.mockRejectedValue(new Error("카드 목록 실패"));
  await click(owner);
  expect(selectFolder).not.toHaveBeenCalled();
  expect(clearFolder).not.toHaveBeenCalled();
  expect(clearCard).not.toHaveBeenCalled();
  expect(notify).toHaveBeenCalledWith(expect.stringContaining("카드 목록 실패"));
});

it("does not let an older feed lookup override a newer selection",async()=>{
  let resolveCards!:(value:{cards:never[]})=>void;
  cardRequest.mockReturnValue(new Promise(resolve=>{resolveCards=resolve;}));
  await act(()=>root.render(<Harness session={owner}/>));
  let oldClick!:()=>void;
  await act(()=>{oldClick=()=>void (host.querySelector("button") as HTMLButtonElement).click();oldClick();});
  await click(linked);
  await act(async()=>{resolveCards({cards:[]});await Promise.resolve();});
  expect(openCard).toHaveBeenCalledTimes(1);
  expect(openCard).toHaveBeenCalledWith("card-1","overlay",null,"linked");
  expect(selectFolder).not.toHaveBeenCalled();
});
