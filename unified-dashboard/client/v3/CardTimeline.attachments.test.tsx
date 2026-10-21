/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CardDetail, CardRow } from "@seosoyoung/soul-ui/cards/card-types";
import { CardTimeline } from "./CardTimeline";
import { cardAttachmentSelectionFromUrl } from "./card-attachment-selection";

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
afterEach(async()=>{await act(()=>root.unmount());container.remove();vi.unstubAllGlobals();vi.restoreAllMocks();});

it("uses explicit attachment URL context and scopes only contextless same-origin content to the current card",()=>{
 expect(cardAttachmentSelectionFromUrl(cardUrl,"card-1","http://localhost:3000")).toEqual({attachmentId:"card-image",context:{type:"card",id:"card-1"}});
 expect(cardAttachmentSelectionFromUrl("/api/attachments/card-image/content","card-1","http://localhost:3000")).toEqual({attachmentId:"card-image",context:{type:"card",id:"card-1"}});
 expect(cardAttachmentSelectionFromUrl("/api/attachments/card-image/content?context_type=card&context_id=another-card","card-1","http://localhost:3000")).toEqual({attachmentId:"card-image",context:{type:"card",id:"another-card"}});
 expect(cardAttachmentSelectionFromUrl("/api/attachments/card-image/content?context_type=session&context_id=session-1","card-1","http://localhost:3000")).toEqual({attachmentId:"card-image",context:{type:"session",id:"session-1"}});
 expect(cardAttachmentSelectionFromUrl("/api/attachments/card-image/content?context_type=owner","card-1","http://localhost:3000")).toEqual({attachmentId:"card-image",context:{type:"owner"}});
 expect(cardAttachmentSelectionFromUrl("https://external.test/api/attachments/card-image/content?context_type=card&context_id=card-1","card-1","http://localhost:3000")).toBeNull();
 expect(cardAttachmentSelectionFromUrl("/api/attachments/card-image/content?context_type=session","card-1","http://localhost:3000")).toBeNull();
 expect(cardAttachmentSelectionFromUrl("/api/attachments/files?nodeId=worker&path=%2Fimage.png","card-1","http://localhost:3000")).toBeNull();
});

it("opens card markdown attachments with fetched metadata and keeps external links external",async()=>{
 const fetchMock=vi.fn(async()=>new Response(JSON.stringify({descriptor:{attachment_id:"card-image",name:"요청.png",mime_type:"image/png",byte_size:512,checksum_sha256:null,width:20,height:10,preview_kind:"image",preview_mime_type:"image/png"},upload_status:"committed"}),{status:200,headers:{"content-type":"application/json"}}));
 vi.stubGlobal("fetch",fetchMock);
 const contextlessUrl="/api/attachments/card-image/content";
 const request=`![요청 이미지](${contextlessUrl})\n\n[외부 안내](https://example.test/guide)`;
 await act(()=>root.render(<CardTimeline card={{...card,request}} detail={detail} portraitUrl={null} pending={false} onAnswer={()=>{}}/>));
 const requestEntry=container.querySelector('[data-card-entry="지시"]')!;
 const image=requestEntry.querySelector<HTMLImageElement>("img")!;
 expect(image.getAttribute("src")).toBe(cardUrl);
 await act(async()=>{image.click();await new Promise(resolve=>setTimeout(resolve,0));});
 expect(fetchMock).toHaveBeenCalledWith("/api/attachments/card-image?context_type=card&context_id=card-1",expect.objectContaining({credentials:"same-origin"}));
 expect(document.body.querySelector(".chat-image-viewer-popup .chat-image-viewer-title")?.textContent).toBe("요청.png");
 expect(requestEntry.querySelector<HTMLAnchorElement>('a[href="https://example.test/guide"]')?.target).toBe("_blank");
});

it.each([false,true])("keeps short comments fully readable without an expand action (commentsOnly=%s)",async(commentsOnly)=>{
 vi.stubGlobal("ResizeObserver",class {observe(){} disconnect(){}});
 await act(()=>root.render(<CardTimeline card={card} detail={detail} commentsOnly={commentsOnly} portraitUrl={null} pending={false} onAnswer={()=>{}}/>));
 const comment=container.querySelector('[data-card-entry="커멘트"]')!;
 const bubble=comment.querySelector<HTMLElement>('[data-slot="chat-message-bubble"]')!;
 expect(comment.querySelector('.v3-card-collapse-hint')).toBeNull();
 expect(bubble.getAttribute("role")).not.toBe("button");
 expect(bubble.hasAttribute("aria-expanded")).toBe(false);
 if(!commentsOnly)expect(comment.querySelector('.v3-card-three-lines')).toBeNull();
});

it.each([false,true])("only folds overflowing PAS comments (commentsOnly=%s)",async(commentsOnly)=>{
 vi.stubGlobal("ResizeObserver",class {observe(){} disconnect(){}});
 vi.spyOn(HTMLElement.prototype,"scrollHeight","get").mockReturnValue(240);
 vi.spyOn(HTMLElement.prototype,"clientHeight","get").mockReturnValue(60);
 const longComment={...detail.comments![0]!,body:Array.from({length:8},(_,index)=>`긴 후속 지시 문장 ${index+1}`).join("\n\n")};
 await act(()=>root.render(<CardTimeline card={card} detail={{...detail,comments:[longComment]}} commentsOnly={commentsOnly} portraitUrl={null} pending={false} onAnswer={()=>{}}/>));
 const comment=container.querySelector('[data-card-entry="커멘트"]')!;
 const bubble=comment.querySelector<HTMLElement>('[data-slot="chat-message-bubble"]')!;
 if(!commentsOnly){
  expect(comment.querySelector('.v3-card-three-lines')).toBeNull();
  expect(comment.querySelector('.v3-card-collapse-hint')).toBeNull();
  expect(bubble.getAttribute("role")).not.toBe("button");
  return;
 }
 expect(bubble.getAttribute("aria-expanded")).toBe("false");
 expect(comment.querySelector('.v3-card-three-lines')?.textContent).toContain("긴 후속 지시 문장 1");
 expect(comment.querySelector('.v3-card-collapse-hint')?.textContent).toBe("더 보기");
 await act(()=>bubble.click());
 expect(bubble.getAttribute("aria-expanded")).toBe("true");
 expect(comment.querySelector('.v3-card-three-lines')).toBeNull();
 expect(comment.querySelector('.v3-card-collapse-hint')?.textContent).toBe("접기");
 await act(()=>bubble.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true})));
 expect(bubble.getAttribute("aria-expanded")).toBe("false");
});

it("uses explicit session context for card body attachments and shows 403 without retry",async()=>{
 const sessionUrl="/api/attachments/session-image/content?context_type=session&context_id=session-1";
 const fetchMock=vi.fn(async(_input:RequestInfo|URL)=>new Response(null,{status:403}));
 vi.stubGlobal("fetch",fetchMock);
 const request=`![세션 첨부](${sessionUrl})`;
 await act(()=>root.render(<CardTimeline card={{...card,request}} detail={detail} portraitUrl={null} pending={false} onAnswer={()=>{}}/>));
 const image=container.querySelector<HTMLImageElement>('[data-card-entry="지시"] img')!;
 expect(image.getAttribute("src")).toBe(sessionUrl);
 await act(async()=>{image.click();await new Promise(resolve=>setTimeout(resolve,0));});
 const viewer=document.body.querySelector<HTMLElement>(".chat-image-viewer-popup")!;
 expect(fetchMock).toHaveBeenCalledTimes(1);
 expect(fetchMock).toHaveBeenCalledWith("/api/attachments/session-image?context_type=session&context_id=session-1",expect.objectContaining({credentials:"same-origin"}));
 expect(viewer.textContent).toContain("첨부를 읽을 수 없습니다.");
 expect(viewer.querySelector("button")?.textContent).not.toContain("다시 시도");
 expect(fetchMock.mock.calls.some(([url])=>String(url).includes("/api/sessions/")||String(url).includes("/api/attachments/files"))).toBe(false);
});

it("opens card body legacy attachments through card-scoped URLs",async()=>{
 const legacyCard={...card,attachments:[{nodeId:"worker one",path:"/incoming/manual.pdf",name:"manual.pdf",mimeType:"application/pdf"}]} as CardRow;
 await act(()=>root.render(<CardTimeline card={legacyCard} detail={detail} portraitUrl={null} pending={false} onAnswer={()=>{}}/>));
 const link=container.querySelector<HTMLAnchorElement>('[data-card-entry="지시"] .v3-card-report-thumbnails a')!;
 expect(link.getAttribute("href")).toBe("/api/attachments/files?nodeId=worker%20one&path=%2Fincoming%2Fmanual.pdf&context_type=card&context_id=card-1&download=true");
 await act(()=>link.click());
 const viewer=document.body.querySelector(".chat-image-viewer-popup");
 expect(viewer?.querySelector(".chat-image-viewer-title")?.textContent).toBe("manual.pdf");
 expect(viewer?.textContent).toContain("원본 저장");
});

it("keeps report and comment attachments in their own card-scoped viewer lists across close and reopen",async()=>{
 const reportFile="/api/attachments/report-file/content?context_type=card&context_id=card-1&download=true";
 const reportImage="/api/attachments/report-image/content?context_type=card&context_id=card-1";
 const commentImage="/api/attachments/comment-image/content?context_type=card&context_id=card-1";
 const textBytes=new TextEncoder().encode("본문 텍스트");
 const metadata={
  "report-file":{attachment_id:"report-file",name:"보고.txt",mime_type:"text/plain",byte_size:textBytes.byteLength,checksum_sha256:null,width:null,height:null,preview_kind:"text" as const,preview_mime_type:"text/plain"},
  "report-image":{attachment_id:"report-image",name:"보고.png",mime_type:"image/png",byte_size:512,checksum_sha256:null,width:20,height:10,preview_kind:"image" as const,preview_mime_type:"image/png"},
  "comment-image":{attachment_id:"comment-image",name:"커멘트.png",mime_type:"image/png",byte_size:512,checksum_sha256:null,width:20,height:10,preview_kind:"image" as const,preview_mime_type:"image/png"},
 };
 const fetchMock=vi.fn(async(input:RequestInfo|URL)=>{
  const url=String(input);
  if(url.includes("/content?"))return new Response(textBytes,{status:206,headers:{"content-type":"text/plain; charset=utf-8","content-length":String(textBytes.byteLength),"content-range":`bytes 0-${textBytes.byteLength-1}/${textBytes.byteLength}`}});
  const id=url.match(/\/api\/attachments\/([^?]+)/)?.[1]??"";
  const descriptor=metadata[id as keyof typeof metadata];
  return descriptor?new Response(JSON.stringify({descriptor,upload_status:"committed"}),{status:200,headers:{"content-type":"application/json"}}):new Response(null,{status:404});
 });
 vi.stubGlobal("fetch",fetchMock);
 const report={...detail.reports[0]!,body:`[보고 파일](${reportFile})\n\n![보고 화면](${reportImage})`};
 const comment={...detail.comments![0]!,body:`![커멘트 화면](${commentImage})`};
 await act(()=>root.render(<CardTimeline card={card} detail={{...detail,reports:[report,detail.reports[1]!],comments:[comment]}} portraitUrl={null} pending={false} onAnswer={()=>{}}/>));
 const reportRoot=container.querySelector('[data-report-id="markdown-report"]')!;
 const reportBubble=reportRoot.closest('[data-card-entry="보고"]')?.querySelector<HTMLElement>('[data-slot="chat-message-bubble"]')!;
 await act(()=>reportBubble.click());
 const reportLink=reportRoot.querySelector<HTMLAnchorElement>(`a[href="${reportFile}"]`)!;
 reportLink.focus();
 await act(async()=>{reportLink.click();await new Promise(resolve=>setTimeout(resolve,0));});
 let viewer=document.body.querySelector<HTMLElement>(".chat-image-viewer-popup")!;
 expect(viewer.querySelector(".chat-image-viewer-title")?.textContent).toBe("보고.txt");
 expect(viewer.querySelector(".chat-image-viewer-count")?.textContent).toBe("1/2");
 expect(viewer.querySelector("pre")?.textContent).toBe("본문 텍스트");
 expect(reportLink.isConnected).toBe(true);
 await act(()=>viewer.querySelector<HTMLButtonElement>('[aria-label="다음 첨부"]')!.click());
 viewer=document.body.querySelector<HTMLElement>(".chat-image-viewer-popup")!;
 expect(viewer.querySelector(".chat-image-viewer-title")?.textContent).toBe("보고.png");
 await act(()=>document.body.querySelector("[role=dialog]")?.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true})));
 await act(async()=>new Promise(resolve=>setTimeout(resolve,0)));
 expect(document.activeElement).toBe(reportLink);
 expect(reportBubble.getAttribute("aria-expanded")).toBe("true");
 await act(async()=>{reportLink.click();await new Promise(resolve=>setTimeout(resolve,0));});
 viewer=document.body.querySelector<HTMLElement>(".chat-image-viewer-popup")!;
 expect(viewer.querySelector(".chat-image-viewer-count")?.textContent).toBe("1/2");
 await act(()=>document.body.querySelector("[role=dialog]")?.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true})));

 const commentLink=container.querySelector<HTMLImageElement>(`[data-card-entry="커멘트"] img[src="${commentImage}"]`)!;
 commentLink.focus();
 await act(async()=>{commentLink.click();await new Promise(resolve=>setTimeout(resolve,0));});
 viewer=document.body.querySelector<HTMLElement>(".chat-image-viewer-popup")!;
 expect(viewer.querySelector(".chat-image-viewer-title")?.textContent).toBe("커멘트.png");
 expect(viewer.querySelector(".chat-image-viewer-count")).toBeNull();
 expect(viewer.querySelector('[aria-label="이전 첨부"]')).toBeNull();
 expect(viewer.querySelector('[aria-label="다음 첨부"]')).toBeNull();
 expect(viewer.querySelector('[aria-label="원본 저장"]')).not.toBeNull();
 expect(viewer.querySelector('[aria-label="Close"]')).not.toBeNull();
 expect(fetchMock.mock.calls.every(([url])=>!String(url).includes("/api/sessions/"))).toBe(true);
 expect(fetchMock.mock.calls.some(([url])=>String(url)==="/api/attachments/report-file?context_type=card&context_id=card-1")).toBe(true);
});

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

it("opens contextless legacy Markdown attachments in the current card context while preserving explicit context",async()=>{
 const contextlessLegacy="/api/attachments/files?nodeId=legacy-node&path=%2Fmedia%2Fcard.txt";
 const explicitLegacy="/api/attachments/files?nodeId=legacy-node&path=%2Fmedia%2Fsession.txt&context_type=session&context_id=session-1";
 const fetchMock=vi.fn(async(input:RequestInfo|URL)=>{
  const url=String(input);
  if(url.includes("/api/attachments/files?"))return new Response(null,{status:200,headers:{"content-type":"text/plain","content-length":"3"}});
  return new Response(null,{status:404});
 });
 vi.stubGlobal("fetch",fetchMock);
 const request=`[카드 파일](${contextlessLegacy})\n\n[세션 파일](${explicitLegacy})`;
 await act(()=>root.render(<CardTimeline card={{...card,request}} detail={detail} portraitUrl={null} pending={false} onAnswer={()=>{}}/>));
 const requestEntry=container.querySelector('[data-card-entry="지시"]')!;
 const cardFileUrl=`${contextlessLegacy}&context_type=card&context_id=card-1`;
 // jsdom's attribute selector rejects this percent-encoded URL even on a single anchor.
 // Compare the exact raw href so the normalization contract remains strict.
 const links=[...requestEntry.querySelectorAll<HTMLAnchorElement>("a")];
 const cardLink=links.find(link=>link.getAttribute("href")===cardFileUrl)!;
 const sessionLink=links.find(link=>link.getAttribute("href")===explicitLegacy)!;
 expect(cardLink).toBeDefined();
 expect(sessionLink).toBeDefined();
 cardLink.focus();
 await act(async()=>{cardLink.click();await new Promise(resolve=>setTimeout(resolve,0));});
 const viewer=document.body.querySelector<HTMLElement>(".chat-image-viewer-popup")!;
 expect(viewer.querySelector(".chat-image-viewer-title")?.textContent).toBe("card.txt");
 expect(fetchMock).toHaveBeenCalledWith(cardFileUrl,expect.objectContaining({method:"HEAD",credentials:"same-origin"}));
 await act(()=>document.body.querySelector("[role=dialog]")?.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true})));
 await act(async()=>new Promise<void>(resolve=>requestAnimationFrame(()=>resolve())));
 expect(document.activeElement).toBe(cardLink);
 await act(async()=>{sessionLink.click();await new Promise(resolve=>setTimeout(resolve,0));});
 expect(fetchMock).toHaveBeenCalledWith(explicitLegacy,expect.objectContaining({method:"HEAD",credentials:"same-origin"}));
});

const metadataResponse=(id:string,name:string)=>Response.json({descriptor:{attachment_id:id,name,mime_type:"text/plain",byte_size:0,checksum_sha256:null,width:null,height:null,preview_kind:"text",preview_mime_type:"text/plain"},upload_status:"committed"});
const title=()=>document.body.querySelector(".chat-image-viewer-title")?.textContent;
const next=()=>document.body.querySelector<HTMLButtonElement>('[aria-label="다음 첨부"]')!;
const closeViewer=async()=>{await act(()=>document.body.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.click());};

it("R2 uses the existing user bubble link tone for request, answer and user comment",async()=>{
 const body="[첨부](/api/attachments/tone/content)";
 await act(()=>root.render(<CardTimeline card={{...card,request:body}} detail={{...detail,questions:[{id:"q",text:body,options:null,answer:body,askedAt:card.createdAt,answeredAt:card.createdAt}],comments:[{...detail.comments![0]!,body}]}} portraitUrl={null} pending={false} onAnswer={()=>{}}/>));
 for(const entry of ["지시","답","커멘트"]){
  const link=container.querySelector(`[data-card-entry="${entry}"] a`)!;
  expect(link.classList.contains("text-white")).toBe(true);
  expect(link.classList.contains("underline")).toBe(true);
  expect(link.classList.contains("text-accent-blue")).toBe(false);
 }
 expect(container.querySelector('[data-card-entry="질문"] a')?.classList.contains("text-accent-blue")).toBe(true);
});

it.each([503,"network"] as const)("R4 retries only the selected metadata after a transient failure (%s)",async failure=>{
 let failed=true;
 const fetchMock=vi.fn(async(input:RequestInfo|URL)=>{
  if(failed){if(failure==="network")throw new TypeError("Failed to fetch");return new Response(null,{status:failure});}
  return metadataResponse(String(input).includes("second")?"second":"first",String(input).includes("second")?"둘째.txt":"첫째.txt");
 });
 vi.stubGlobal("fetch",fetchMock);
 await act(()=>root.render(<CardTimeline card={{...card,request:"[첫 파일](/api/attachments/first/content)\n\n[둘째 파일](/api/attachments/second/content)"}} portraitUrl={null} pending={false} onAnswer={()=>{}}/>));
 await act(async()=>{container.querySelector<HTMLAnchorElement>('a')!.click();await new Promise(resolve=>setTimeout(resolve,0));});
 const retry=document.body.querySelector<HTMLButtonElement>('.chat-image-viewer-panel button');
 expect(document.body.querySelector('.chat-image-viewer-panel [role="status"]')?.textContent).toContain("첨부를 불러오지 못했습니다.");
 expect(retry?.textContent).toBe("다시 시도");
 failed=false;const before=fetchMock.mock.calls.length;
 await act(async()=>{retry!.click();await new Promise(resolve=>setTimeout(resolve,0));});
 expect(title()).toBe("첫째.txt");
 expect(fetchMock.mock.calls.length-before).toBe(1);
 expect(fetchMock.mock.calls.at(-1)?.[0]).toBe("/api/attachments/first?context_type=card&context_id=card-1");
 expect(document.body.querySelector(".chat-image-viewer-panel button")).toBeNull();
});

it.each([401,403,404])("R4 keeps metadata %s terminal with no retry",async status=>{
 vi.stubGlobal("fetch",vi.fn(async()=>new Response(null,{status})));
 await act(()=>root.render(<CardTimeline card={{...card,request:"[첨부](/api/attachments/denied/content)"}} portraitUrl={null} pending={false} onAnswer={()=>{}}/>));
 await act(async()=>{container.querySelector<HTMLAnchorElement>('a')!.click();await new Promise(resolve=>setTimeout(resolve,0));});
 expect(document.body.querySelector('.chat-image-viewer-panel [role="status"]')?.textContent).toBe(status===404?"첨부를 찾을 수 없습니다.":"첨부를 읽을 수 없습니다.");
 expect(document.body.querySelector(".chat-image-viewer-panel button")).toBeNull();
});

it("R6 includes full, collapsed and shortcut reference links in display order",async()=>{
 vi.stubGlobal("fetch",vi.fn(async(input:RequestInfo|URL)=>{
  const id=String(input).match(/attachments\/([^?]+)/)![1]!;return metadataResponse(id,`${id}.txt`);
 }));
 const request="[첫 파일][a]\n\n[둘 파일][]\n\n[셋 파일]\n\n[a]: /api/attachments/first/content\n[둘 파일]: /api/attachments/second/content\n[셋 파일]: /api/attachments/third/content\n\n`[코드][a]`";
 await act(()=>root.render(<CardTimeline card={{...card,request}} portraitUrl={null} pending={false} onAnswer={()=>{}}/>));
 await act(async()=>{container.querySelector<HTMLAnchorElement>('a')!.click();await new Promise(resolve=>setTimeout(resolve,0));});
 expect(document.body.querySelector(".chat-image-viewer-count")?.textContent).toBe("1/3");
 await act(async()=>{next().click();await new Promise(resolve=>setTimeout(resolve,0));});expect(title()).toBe("second.txt");
 await act(async()=>{next().click();await new Promise(resolve=>setTimeout(resolve,0));});expect(title()).toBe("third.txt");
});

it("R7 opens the clicked legacy occurrence when the request also lists the same attachment",async()=>{
 vi.stubGlobal("fetch",vi.fn(async()=>new Response(null,{status:200,headers:{"content-length":"0"}})));
 const legacy="/api/attachments/files?nodeId=legacy-node&path=%2Fincoming%2Fnotes.txt";
 const value={...card,request:`[기존 파일](${legacy})`,attachments:[{nodeId:"legacy-node",path:"/incoming/notes.txt",name:"notes.txt",mimeType:"text/plain"}]};
 await act(()=>root.render(<CardTimeline card={value} portraitUrl={null} pending={false} onAnswer={()=>{}}/>));
 const trigger=container.querySelector<HTMLAnchorElement>('.v3-card-report-thumbnails a')!;
 await act(async()=>{trigger.click();await new Promise(resolve=>setTimeout(resolve,0));});
 expect(document.body.querySelector(".chat-image-viewer-count")?.textContent).toBe("2/2");
 expect(title()).toBe("notes.txt");
 await closeViewer();
 const link=container.querySelector<HTMLAnchorElement>('[data-card-entry="지시"] a')!;
 await act(async()=>{link.click();await new Promise(resolve=>setTimeout(resolve,0));});
 expect(document.body.querySelector(".chat-image-viewer-count")?.textContent).toBe("1/2");
 expect(title()).toBe("notes.txt");
});

it("R8 opens the existing loading surface before metadata resolves",async()=>{
 let resolve!: (response:Response)=>void;
 vi.stubGlobal("fetch",vi.fn(()=>new Promise<Response>(done=>{resolve=done;})));
 await act(()=>root.render(<CardTimeline card={{...card,request:"[첨부](/api/attachments/pending/content)"}} portraitUrl={null} pending={false} onAnswer={()=>{}}/>));
 await act(()=>container.querySelector<HTMLAnchorElement>('a')!.click());
 expect(document.body.querySelector('.chat-image-viewer-panel [role="status"]')?.textContent).toBe("미리보기를 불러오는 중…");
 await act(async()=>{resolve(metadataResponse("pending","완료.txt"));await new Promise(done=>setTimeout(done,0));});
 expect(title()).toBe("완료.txt");
});
