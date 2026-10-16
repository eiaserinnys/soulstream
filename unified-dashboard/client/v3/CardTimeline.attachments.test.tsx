/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { CardDetail, CardRow } from "@seosoyoung/soul-ui/cards/card-types";
import { CardTimeline } from "./CardTimeline";

const cardUrl="/api/attachments/card-image/content?context_type=card&context_id=card-1";
const card={
 id:"card-1",folderId:"folder-1",title:"첨부 표시",request:`요청 내용\n\n![요청 화면](${cardUrl})`,brief:"",status:"review",
 blockedKind:null,blockedDetail:null,positionKey:"a",queuePositionKey:null,assigneeKind:null,assigneeAgentId:null,
 assigneeUserId:null,assigneeSessionId:null,nodeId:"eiaserinnys",modelPreset:null,version:1,archived:false,
 createdAt:"2026-10-05T01:00:00Z",updatedAt:"2026-10-05T01:00:00Z",attachments:[],
} as unknown as CardRow;
const detail={
 card,
 reports:[
  {id:"markdown-report",title:"Markdown 보고",format:"markdown",body:`확인 결과\n\n![보고 화면](${cardUrl})`,createdAt:"2026-10-05T02:00:00Z",sessionId:null},
  {id:"html-report",title:"HTML 보고",format:"html",body:"<p>HTML 보고 내용</p>",createdAt:"2026-10-05T03:00:00Z",sessionId:null},
 ],
 questions:[],comments:[{id:"comment-1",cardId:"card-1",authorKind:"user",authorId:"user-1",sessionId:null,kind:"comment",body:`의견\n\n![커멘트 화면](${cardUrl})`,createdAt:"2026-10-05T04:00:00Z"}],
 sessions:[],
} as unknown as CardDetail;

let container:HTMLDivElement,root:Root;
beforeEach(()=>{
 (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
 container=document.createElement("div");document.body.append(container);root=createRoot(container);
});
afterEach(async()=>{await act(()=>root.unmount());container.remove();});

it("keeps server-projected card URLs in request, collapsed and expanded report, and comment markdown",async()=>{
 await act(()=>root.render(<CardTimeline card={card} detail={detail} portraitUrl={null} pending={false} onAnswer={()=>{}}/>));
 const source=(element:ParentNode|null)=>element?.querySelector<HTMLImageElement>("img")?.getAttribute("src");
 const request=container.querySelector('[data-card-entry="지시"]');
 expect(source(request)).toBe(cardUrl);

 const report=container.querySelector('[data-report-id="markdown-report"]')!;
 expect(source(report.querySelector(".v3-card-report-thumbnails"))).toBe(cardUrl);
 const bubble=report.closest('[data-card-entry="보고"]')?.querySelector<HTMLElement>('[data-slot="chat-message-bubble"]')!;
 expect(bubble.getAttribute("aria-expanded")).toBe("false");
 await act(()=>bubble.dispatchEvent(new MouseEvent("click",{bubbles:true})));
 expect(bubble.getAttribute("aria-expanded")).toBe("true");
 expect(report.querySelector(".v3-card-report-thumbnails")).toBeNull();
 expect(source(report)).toBe(cardUrl);

 const comment=container.querySelector('[data-card-entry="커멘트"]');
 expect(source(comment)).toBe(cardUrl);
 const htmlReport=container.querySelector('[data-report-id="html-report"]')!;
 const htmlBubble=htmlReport.closest('[data-card-entry="보고"]')?.querySelector<HTMLElement>('[data-slot="chat-message-bubble"]')!;
 await act(()=>htmlBubble.dispatchEvent(new MouseEvent("click",{bubbles:true})));
 expect(htmlReport.querySelector("iframe")).not.toBeNull();
});
