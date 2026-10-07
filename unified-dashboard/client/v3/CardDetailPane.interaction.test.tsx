/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useCardStore } from "@seosoyoung/soul-ui/cards/card-store";
import { useDashboardStore } from "@seosoyoung/soul-ui";
import { CardDetailPane } from "./CardDetailPane";
import type { CardDetail } from "@seosoyoung/soul-ui/cards/card-types";

vi.mock("./useCardSessionPages",async original=>({...await original<typeof import("./useCardSessionPages")>(),useCardSessionPages:()=>({sessions:[],loading:false})}));
vi.mock("@seosoyoung/soul-ui/cards/CardSessionVirtualList",()=>({CardSessionVirtualList:({data,itemContent}:any)=><div>{data.map((row:any,i:number)=><div key={i}>{itemContent(i,row)}</div>)}</div>}));
vi.mock("@seosoyoung/soul-ui", async original => ({
  ...await original<typeof import("@seosoyoung/soul-ui")>(),
  useAuth: () => ({user:null}), useSessionListProvider: () => ({sessions:[],loading:false}),
}));
const card = {id:"inherit",folderId:"f",title:"행 제목",request:"요청 첫 줄\n다음 줄",brief:"펼친 내부 요약",status:"running",blockedKind:null,version:1,createdAt:"2026-10-01",updatedAt:"2026-10-01",nodeId:"node",assigneeSessionId:"owner",assigneeAgentId:"roselin",modelPreset:"sol"} as CardDetail["card"];
const detail:CardDetail = {card,sessions:[],comments:[{id:"c",cardId:card.id,authorKind:"user",authorId:"sample",sessionId:null,kind:"comment",body:"커멘트 본문",createdAt:card.createdAt}],questions:[{id:"q",text:"질문 본문",options:["답변"],answer:"답변 본문",askedAt:card.createdAt,answeredAt:card.createdAt}],reports:[{id:"r",sessionId:null,title:"최신 보고 제목",format:"markdown",body:"첫 줄\n둘째 줄\n셋째 줄\n넷째 줄\n\n![캡처](https://example.test/capture.png)",createdAt:"2026-10-01"}]};
let container:HTMLDivElement,root:Root;
beforeEach(()=>{
  vi.stubGlobal("PointerEvent",MouseEvent);
  useDashboardStore.setState({drafts:{}});
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
  container=document.createElement("div");document.body.append(container);root=createRoot(container);
  useCardStore.setState({byId:{inherit:card},details:{inherit:detail},loadCard:vi.fn().mockResolvedValue(detail)});
});
afterEach(async()=>{await act(()=>root.unmount());container.remove();useCardStore.getState().reset();vi.restoreAllMocks();});

const render=async(onClose=vi.fn())=>{await act(()=>root.render(<CardDetailPane cardId="inherit" folders={[]} onClose={onClose} onOpenSession={()=>{}}/>));return onClose;};
const tab=async(name:string)=>{await act(()=>[...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(el=>el.textContent?.includes(name))!.click());};
const item=(id:number,display:"todo"|"doing"|"reported"|"changed"|"fix"|"confirmed"|"dropped")=>({id,title:`확인 항목 ${id}`,state:display==="confirmed"?"done" as const:display==="dropped"?"dropped" as const:display==="doing"||display==="fix"?"doing" as const:display==="reported"||display==="changed"?"done" as const:"todo" as const,result:display==="dropped"?"제외한 까닭":`항목 ${id} 결과`,evidence:[],caveat:null,rev:1,confirmed:display==="confirmed"?{at:card.createdAt,rev:1}:null,fixOpen:display==="fix"?2:0,reopened:display==="changed"?"변경 뒤 다시 확인":null,from:null,createdAt:card.createdAt,reportedAt:card.createdAt,display});
it("keeps the old card on comments and keeps session selection and composer mounted across four tabs",async()=>{
 await render();
 expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain("커멘트");
 for(const label of ["지시","보고","커멘트","질문","답"])expect(container.querySelector(`[data-card-entry="${label}"]`)).not.toBeNull();
 const sessions=container.querySelector('[data-card-section="sessions"]')!;
 const textarea=container.querySelector('textarea')!;
 Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")!.set!.call(textarea,"작성 중");
 await act(()=>textarea.dispatchEvent(new Event("input",{bubbles:true})));
 expect(useDashboardStore.getState().drafts["composer:card-comment:inherit"]).toBe("작성 중");
 await tab("세션");
 expect(container.querySelector('[data-card-section="sessions"]')).toBe(sessions);
 expect(sessions.hasAttribute("hidden")).toBe(false);
 await tab("노트");
 expect(container.querySelector('[data-card-section="sessions"]')).toBe(sessions);
 expect(sessions.hasAttribute("hidden")).toBe(true);
 expect(container.querySelector('[data-card-tab-panel="notes"]')?.textContent).toContain("인계 요약");
 await tab("커멘트");
 expect(container.querySelector('textarea')).toBe(textarea);
 expect(textarea.closest('[hidden]')).toBeNull();
 expect(container.querySelector('[data-card-tab-panel="comments"] [data-card-entry="지시"]')).not.toBeNull();
 expect(container.querySelector('textarea')).toBe(textarea);expect(textarea.value).toBe("작성 중");
});
it("opens the items tab when items arrive and keeps the four tab order",async()=>{
 const withItems={...card,items:[item(1,"doing")],now:{text:"현재 상황",turn:"agent" as const,ask:null,updatedAt:card.updatedAt,sessionId:"owner"}};
 const withDetail={...detail,card:withItems,notes:Array.from({length:6},(_,index)=>({id:`note-${index}`,cardId:card.id,authorKind:"agent" as const,authorId:"roselin",sessionId:null,kind:"note" as const,body:`노트 ${index+1}`,createdAt:`2026-10-01T0${index+1}:00:00Z`}))};
 useCardStore.setState({byId:{inherit:withItems},details:{inherit:withDetail}});
 await render();
 expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain("확인 항목");
 expect([...container.querySelectorAll('[role="tab"]')].map(button=>button.textContent?.replace(/\d+/g,"").trim())).toEqual(["확인 항목","커멘트","세션","노트"]);
 expect(container.querySelector('[data-item-display="doing"]')).not.toBeNull();
 expect(container.querySelector('[data-now-view="current"]')).not.toBeNull();
 await tab("노트");
 expect(container.querySelector('[data-card-tab-panel="notes"]')?.textContent).toContain("앞선 노트 1건");
 await act(()=>container.querySelector<HTMLButtonElement>('.v3-card-note-more')!.click());
 expect(container.querySelectorAll('[data-card-note-id]')).toHaveLength(6);
});
it("counts only reported and changed items in the tab and hides a zero count",async()=>{
 const withItems={...card,items:[item(1,"doing"),item(2,"reported"),item(3,"changed"),item(4,"fix")]};
 useCardStore.setState({byId:{inherit:withItems},details:{inherit:{...detail,card:withItems}}});
 await render();
 expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("확인 항목2");
 const confirmed={...withItems,items:withItems.items.map(value=>item(value.id,"confirmed"))};
 await act(()=>useCardStore.setState({byId:{inherit:confirmed},details:{inherit:{...detail,card:confirmed}}}));
 expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("확인 항목");
});
it("sends from the current tab, targets an item comment, then clears its unread marker on Comments",async()=>{
 const withItems={...card,items:[item(4,"doing")],now:{text:"현재 상황",turn:"user" as const,ask:"결과를 확인해 주세요",updatedAt:card.updatedAt,sessionId:"owner"}};
 useCardStore.setState({byId:{inherit:withItems},details:{inherit:{...detail,card:withItems}},addComment:vi.fn().mockResolvedValue(undefined)});
 await render();
 const textarea=container.querySelector('textarea')!;
 await act(()=>container.querySelector<HTMLButtonElement>('[data-item-id="4"] .v3-card-check-item-target')!.click());
 expect(container.querySelector('[data-testid="card-detail"]')?.textContent).toContain("대상: 4번 확인 항목 4");
 expect(document.activeElement).toBe(textarea);
 Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")!.set!.call(textarea,"입력 폭을 고쳐 주세요");
 await act(()=>textarea.dispatchEvent(new Event("input",{bubbles:true})));
 await act(async()=>textarea.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",ctrlKey:true,bubbles:true})));
 expect(useCardStore.getState().addComment).toHaveBeenCalledWith("inherit","입력 폭을 고쳐 주세요",expect.any(String),4);
 expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain("확인 항목");
 expect(container.querySelector('[aria-label="새 커멘트"]')).not.toBeNull();
 expect(container.textContent).toContain("보냈습니다.");
 await tab("커멘트");
 expect(container.querySelector('[aria-label="새 커멘트"]')).toBeNull();
});
it("unchecking targets and focuses the composer without sending",async()=>{
 const confirmed={...card,items:[item(1,"confirmed")]};
 useCardStore.setState({byId:{inherit:confirmed},details:{inherit:{...detail,card:confirmed}},confirmItem:vi.fn().mockResolvedValue(undefined),addComment:vi.fn()});
 await render();
 const textarea=container.querySelector('textarea')!;
 await act(()=>container.querySelector<HTMLButtonElement>('[data-item-id="1"] [role="checkbox"]')!.click());
 expect(useCardStore.getState().confirmItem).toHaveBeenCalledWith("inherit",1,false);
 expect(container.querySelector('.v3-card-target-notice')).not.toBeNull();
 expect(document.activeElement).toBe(textarea);
 expect(useCardStore.getState().addComment).not.toHaveBeenCalled();
});
it("closes after successful completion",async()=>{
 useCardStore.setState({byId:{inherit:{...card,status:"review"}},details:{inherit:{...detail,card:{...card,status:"review"}}},mutate:vi.fn().mockResolvedValue(undefined)});
 const close=await render();
 await act(async()=>{container.querySelector<HTMLButtonElement>('[aria-label="완료"]')!.click();await Promise.resolve();});
 expect(useCardStore.getState().mutate).toHaveBeenCalledWith("inherit","/status",{status:"done",expectedVersion:1});
 expect(close).toHaveBeenCalledTimes(1);
});
it("closes the review sample after completion and has no undo action",async()=>{
 const sampleCard={...card,status:"review" as const,items:[item(1,"todo")]};
 const sample={...detail,card:sampleCard};
 const close=vi.fn();
 await act(()=>root.render(<CardDetailPane cardId="inherit" folders={[]} onClose={close} onOpenSession={()=>{}} sampleDetail={sample}/>));
 expect(container.textContent).not.toContain("되돌리기");
 await act(()=>container.querySelector<HTMLButtonElement>('button[aria-label="완료"]')!.click());
 expect(close).toHaveBeenCalledTimes(1);
});
it("publishes sample confirmation changes to the shared fixture owner",async()=>{
 const sample={...detail,card:{...card,items:[item(1,"reported")]}};
 const change=vi.fn();
 await act(()=>root.render(<CardDetailPane cardId="inherit" folders={[]} onClose={()=>{}} onOpenSession={()=>{}} sampleDetail={sample} onSampleChange={change}/>));
 await act(()=>container.querySelector<HTMLElement>('[data-item-id="1"] [role="checkbox"]')!.click());
 expect(change).toHaveBeenCalledTimes(1);
 const updated=change.mock.calls[0][0](sample);
 expect(updated.card.items[0].display).toBe("confirmed");
 expect(updated.comments).toEqual(sample.comments);
});
it("keeps the panel open and shows the store error when completion fails",async()=>{
 useCardStore.setState({byId:{inherit:{...card,status:"review"}},mutate:vi.fn().mockImplementation(async()=>{useCardStore.setState({errors:{inherit:"완료 실패"}});throw new Error("완료 실패");})});
 const close=await render();await act(async()=>{container.querySelector<HTMLButtonElement>('[aria-label="완료"]')!.click();await Promise.resolve();});
 expect(close).not.toHaveBeenCalled();expect(container.querySelector('[role="alert"]')?.textContent).toBe("완료 실패");
});

it("resets the selected tab when a different card opens",async()=>{
 await render();await tab("세션");
 const other={...card,id:"other"};await act(()=>useCardStore.setState({byId:{inherit:card,other},details:{inherit:detail,other:{...detail,card:other}}}));
 await act(()=>root.render(<CardDetailPane cardId="other" folders={[]} onClose={()=>{}} onOpenSession={()=>{}}/>));
 expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("커멘트");
 expect(container.querySelector('[data-card-entry="지시"]')).not.toBeNull();
});
it("shows structured request attachments and opens the existing image viewer",async()=>{
 const attachments=[{nodeId:"node",path:"/incoming/upload/이미지.png",name:"첨부 이미지.png",mimeType:"image/png"},{nodeId:"other",path:"/incoming/upload/notes.pdf",name:"설명.pdf",mimeType:"application/pdf"}];
 useCardStore.setState({byId:{inherit:{...card,attachments}},details:{inherit:{...detail,card:{...card,attachments}}}});
 await render();const image=container.querySelector<HTMLImageElement>('img[alt="첨부 이미지.png"]')!;
 expect(image).not.toBeNull();expect(image.src).toContain('nodeId=node');expect(image.src).toContain(encodeURIComponent(attachments[0].path));
 expect(container.querySelector<HTMLAnchorElement>('a[href*="nodeId=other"]')?.textContent).toContain("설명.pdf");
 await act(()=>image.click());expect(document.querySelector('[role="dialog"] img')?.getAttribute('alt')).toBe('첨부 이미지.png');
});

it("uses cached summary detail immediately while refreshing it in the background",async()=>{
 const cached={...detail,card:{...card,title:"캐시된 제목",request:"캐시된 요청",attachments:[],now:null,items:[]}};
 const loadCard=vi.fn(()=>new Promise<CardDetail>(()=>{}));
 useCardStore.setState({byId:{inherit:cached.card},details:{inherit:cached},errors:{inherit:"이전 요청 오류"},loadCard});
 await act(()=>root.render(<CardDetailPane variant="summary" cardId="inherit" folders={[]} onClose={()=>{}} onOpenSession={()=>{}} onOpenCard={()=>{}}/>));

 expect(container.querySelector('.v3-card-read-summary-title')?.textContent).toBe("캐시된 제목");
 expect(container.textContent).toContain("캐시된 요청");
 expect(container.querySelector('[role="alert"]')).toBeNull();
 expect(loadCard).toHaveBeenCalledOnce();
});

it("opens the existing full card through the summary callback without exposing mutations",async()=>{
 const summaryCard={...card,number:41,request:"요청 본문",attachments:[],now:null,items:[]};
 const summary:CardDetail={...detail,card:summaryCard,reports:[],questions:[],comments:[]};
 const openCard=vi.fn(),mutate=vi.fn(),execute=vi.fn(),confirmItem=vi.fn(),addComment=vi.fn();
 useCardStore.setState({byId:{inherit:summaryCard},details:{inherit:summary},mutate,execute,confirmItem,addComment});
 await act(()=>root.render(<CardDetailPane variant="summary" cardId="inherit" folders={[]} onClose={()=>{}} onOpenSession={()=>{}}
  onOpenCard={openCard} sampleDetail={summary}/>));

 expect(container.querySelectorAll("button")).toHaveLength(1);
 expect(container.querySelector('[role="tab"]')).toBeNull();
 expect(container.querySelector("textarea")).toBeNull();
 await act(()=>[...container.querySelectorAll<HTMLButtonElement>("button")].find(button=>button.textContent?.includes("카드 열기"))!.click());
 expect(openCard).toHaveBeenCalledTimes(1);
 expect(mutate).not.toHaveBeenCalled();expect(execute).not.toHaveBeenCalled();
 expect(confirmItem).not.toHaveBeenCalled();expect(addComment).not.toHaveBeenCalled();
});

it("reopens a completed detail through the existing status menu without reports",async()=>{
 const completed={...card,status:"done" as const,version:8};const current={...detail,card:completed,reports:[]};
 const loadCard=vi.fn().mockResolvedValue(current),mutate=vi.fn().mockResolvedValue(undefined),execute=vi.fn().mockResolvedValue(current);
 useCardStore.setState({byId:{inherit:completed},details:{inherit:current},loadCard,mutate,execute});
 await act(()=>root.render(<CardDetailPane cardId="inherit" folders={[]} onClose={vi.fn()} onOpenSession={vi.fn()}/>));
 await act(async()=>container.querySelector<HTMLButtonElement>('button[aria-label="카드 상태 변경"]')!.click());
 const move=[...document.querySelectorAll<HTMLButtonElement>('[data-card-status-picker] button')].find(button=>button.textContent==="실행 중")!;
 await act(async()=>move.click());
 expect(execute).toHaveBeenCalledWith("inherit",8);expect(mutate).not.toHaveBeenCalled();
});

it("PATCHes a color chosen from the detail pane with the freshly loaded card version",async()=>{
 const latest={...detail,card:{...card,color:"blue" as const,version:9}};
 const loadCard=vi.fn().mockResolvedValue(latest),mutate=vi.fn().mockResolvedValue(latest);
 useCardStore.setState({byId:{inherit:latest.card},details:{inherit:latest},loadCard,mutate});
 await render();
 await act(async()=>container.querySelector<HTMLButtonElement>('button[aria-label="카드 상태 변경"]')!.click());
 const colorRow=[...document.querySelectorAll<HTMLButtonElement>('[data-card-status-picker] button')].find(button=>button.textContent==="카드 색상: 하늘")!;
 await act(async()=>colorRow.click());
 const mint=[...document.querySelectorAll<HTMLButtonElement>('[data-card-status-picker] button')].find(button=>button.textContent==="민트")!;
 await act(async()=>mint.click());
 expect(mutate).toHaveBeenCalledWith("inherit","",{color:"mint",expectedVersion:9},"PATCH");
 expect(container.querySelector('[data-card-status-picker]')).toBeNull();
});


it("shows editable settings for agent preassignment and hides only settings after assignment",async()=>{
 const unassigned={...card,assigneeKind:"agent" as const,assigneeSessionId:null};
 useCardStore.setState({byId:{inherit:unassigned},details:{inherit:{...detail,card:unassigned}},loadCard:vi.fn().mockResolvedValue({...detail,card:unassigned})});
 await render();expect(container.querySelector('button[aria-label="카드 실행 설정 편집"]')).not.toBeNull();
 await act(()=>useCardStore.setState({byId:{inherit:card},details:{inherit:detail}}));
 expect(container.querySelector('button[aria-label="카드 실행 설정 편집"]')).toBeNull();
 expect(container.querySelector('button[aria-label="완료"]')).not.toBeNull();
 expect(container.querySelector('[data-card-section="sessions"]')).not.toBeNull();expect(container.querySelector('textarea')).not.toBeNull();
});

it.each(['todo','queued'] as const)('starts a %s detail through the existing status controller and stays open',async status=>{
 const source={...card,status};const latest={...detail,card:source};const execute=vi.fn().mockResolvedValue({card:{...source,status:'running'},execution:{state:'pending',requestId:'req',sessionId:'owner'}});
 useCardStore.setState({byId:{inherit:source},details:{inherit:latest},loadCard:vi.fn().mockResolvedValue(latest),execute});
 const close=await render();await act(async()=>{container.querySelector<HTMLButtonElement>('[aria-label="시작하기"]')!.click();});
 expect(execute).toHaveBeenCalledWith('inherit',1);expect(close).not.toHaveBeenCalled();expect(document.querySelector('[data-card-status-picker]')).toBeNull();
});
