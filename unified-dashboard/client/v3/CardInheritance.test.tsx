/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { useCardStore } from "@seosoyoung/soul-ui/cards/card-store";
import { useDashboardStore } from "@seosoyoung/soul-ui";
import { useCardNavigation } from "./card-navigation";
import { CardRow } from "./CardRow";
import { RichSessionRow } from "./RichSessionRow";
import { CardCommentInput } from "./CardCommentInput";
import { CardDetailPane } from "./CardDetailPane";
import { CardRowView } from "./CardRow";
import type { CardDetail } from "@seosoyoung/soul-ui/cards/card-types";

vi.mock("@seosoyoung/soul-ui", async original => ({
  ...await original<typeof import("@seosoyoung/soul-ui")>(),
  useAuth: () => ({user:null}), useSessionListProvider: () => ({sessions:[],loading:false}),
}));
const card = {id:"inherit",folderId:"f",title:"행 제목",request:"요청 첫 줄\n다음 줄",brief:"",status:"running",blockedKind:null,version:1,createdAt:"2026-10-01",updatedAt:"2026-10-01",nodeId:"node",assigneeSessionId:"owner",assigneeAgentId:"roselin",modelPreset:"sol"} as CardDetail["card"];
const detail:CardDetail = {card,sessions:[],questions:[],comments:[],reports:[{id:"r",sessionId:null,title:"최신 보고 제목",format:"markdown",body:"첫 줄\n둘째 줄\n셋째 줄\n넷째 줄\n\n![캡처](https://example.test/capture.png)",createdAt:"2026-10-01"}]};
let container:HTMLDivElement,root:Root;
beforeEach(()=>{
  useDashboardStore.setState({drafts:{}});
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
  container=document.createElement("div");document.body.append(container);root=createRoot(container);
  useCardStore.setState({byId:{inherit:card},details:{inherit:detail},loadCard:vi.fn().mockResolvedValue(detail)});
});
afterEach(async()=>{await act(()=>root.unmount());container.remove();useCardStore.getState().reset();vi.restoreAllMocks();});

it("uses the run row's three text lines and list activity without fetching detail",async()=>{
  await act(()=>root.render(<CardRow card={{...card,latestActivity:{kind:"report",format:"markdown",body:"보고 원문 첫 줄\n다음 줄",createdAt:card.createdAt}}} folderLabel="오늘 폴더"/>));
  const copy=container.querySelector(".v3-run-copy")!;
  expect(copy.querySelector(".v3-run-identity")?.children).toHaveLength(2);
  expect(copy.querySelector(".v3-run-agent-line")?.textContent).toContain("오늘 폴더");
  expect(copy.querySelector("small")?.textContent).toBe("보고 원문 첫 줄");
  expect(useCardStore.getState().loadCard).not.toHaveBeenCalled();
  expect(container.querySelector(".v3-run-trailing time")).not.toBeNull();
});

it("respects null activity instead of showing a cached report title or automatic comment",()=>{
 container.innerHTML=renderToStaticMarkup(<CardRowView card={{...card,latestActivity:null}} detail={detail} onOpen={()=>{}}/>);
 expect(container.querySelector("small")?.textContent).toBe("요청 첫 줄");
});

it("small session rows omit only the preview while retaining the default text and avatar classes",()=>{
  const session={agentSessionId:"s",displayName:"세션",agentId:"roselin",nodeId:"node",modelLabel:"Sol",status:"completed",createdAt:"2026-10-01",eventCount:1} as const;
  const base=renderToStaticMarkup(<RichSessionRow session={session} onOpen={()=>{}}/>);
  const small=renderToStaticMarkup(<RichSessionRow session={session} onOpen={()=>{}} size="small"/>);
  expect(base).toContain("<small>");expect(small).not.toContain("<small>");
  expect(small).toContain("v3-run-row--small");
  for(const name of ["v3-run-open","v3-run-avatar","v3-run-title-line","v3-run-agent-line"])expect(small).toContain(name);
});

it("keeps card state in the status slot and only the title in the title line",()=>{
 container.innerHTML=renderToStaticMarkup(<CardRowView card={card} detail={detail} onOpen={()=>{}}/>);
 expect(container.querySelector(".v3-run-title-line")?.textContent).toBe(card.title);
 expect(container.querySelector('.v3-run-trailing [data-slot="status-chip"]')?.textContent).toBe("카드 진행 중");
});

it("does not reserve a mode slot for the card's empty icon",async()=>{
 await act(()=>root.render(<CardCommentInput cardId="inherit" pending={false} onSend={vi.fn().mockResolvedValue(true)}/>));
 const textarea=container.querySelector('[data-slot="chat-input-body"]')!;
 expect(textarea.previousElementSibling).toBeNull();
});

it("expands reports by the bubble, keeps images independently clickable, and renders no more/details button row",async()=>{
  await act(()=>root.render(<CardDetailPane cardId="inherit" folders={[]} onClose={()=>{}} onOpenSession={()=>{}}/>));
  const entry=container.querySelector('[data-card-entry="보고"]')!;
  const bubble=entry.querySelector<HTMLElement>('[data-slot="chat-message-bubble"]')!;
  expect(bubble.getAttribute("aria-expanded")).toBe("false");
  expect(entry.querySelector("details,button.v3-card-more")).toBeNull();
  const thumbnail=entry.querySelector<HTMLImageElement>("img[alt=캡처]")!;
  await act(()=>thumbnail.click());
  expect(document.querySelector('[role="dialog"] img')?.getAttribute("src")).toBe("https://example.test/capture.png");
  expect(bubble.getAttribute("aria-expanded")).toBe("false");
});

it("comments inherit chat input, attachment and send controls",async()=>{
  await act(()=>root.render(<CardDetailPane cardId="inherit" folders={[]} onClose={()=>{}} onOpenSession={()=>{}}/>));
  expect(container.querySelector('[data-slot="chat-input-composer"]')).not.toBeNull();
  expect(container.querySelector<HTMLTextAreaElement>('textarea[data-slot="chat-input-body"]')?.rows).toBe(1);
  expect(container.querySelector('button[title="Attach files"]')).not.toBeNull();
  expect(container.querySelector('[data-testid="send-button"]')).not.toBeNull();
});

it("card CSS leaves shared run, bubble and input dimensions to their canonical styles",()=>{
  const css=readFileSync("client/v3/v3-cards.css","utf8");
  expect(css).not.toMatch(/\.v3-card-row\s*\{/);
  expect(css).not.toMatch(/\.v3-card-session-history\s+\.v3-run-/);
  expect(css).not.toContain('[data-slot="chat-message-bubble"]');
  expect(css).not.toContain(".v3-card-comment-input textarea");
});

it("opens cards in the folder workspace overlay",async()=>{
 await act(()=>root.render(<CardRow card={card}/>));
 await act(()=>container.querySelector<HTMLElement>(".v3-run-open")!.click());
 expect(useCardNavigation.getState().placement).toBe("overlay");
});
it("folder card lists grow with their contents instead of overflowing into the board",()=>{
 const css=readFileSync("client/v3/v3-folder-workspace.css","utf8");
 expect(css.match(/\.v3-folder-cards\s*\{([^}]+)\}/)?.[1]??"").not.toContain("max-height");
});

it("comments inherit Enter newline and Ctrl/Cmd+Enter submission from ChatInputEditor",async()=>{
 const send=vi.fn().mockResolvedValue(true);
 await act(()=>root.render(<CardCommentInput cardId="inherit" pending={false} onSend={send}/>));
 const textarea=container.querySelector("textarea")!;
 const edit=async(text:string)=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")!.set!.call(textarea,text);await act(()=>textarea.dispatchEvent(new Event("input",{bubbles:true})));};
 const key=async(options:KeyboardEventInit={})=>{const event=new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true,...options});await act(async()=>{textarea.dispatchEvent(event);await Promise.resolve();});return event;};
 await edit("커멘트 첫 줄");
 expect((await key()).defaultPrevented).toBe(false);expect(send).not.toHaveBeenCalled();
 expect(container.querySelector("form")).toBeNull();
 expect((await key({ctrlKey:true})).defaultPrevented).toBe(true);expect(send).toHaveBeenCalledWith("커멘트 첫 줄");
 await edit("커멘트 둘째 줄");
 expect((await key({metaKey:true})).defaultPrevented).toBe(true);expect(send).toHaveBeenCalledTimes(2);
});
