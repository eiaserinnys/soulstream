/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CardCheckItem, CardItemEvidence } from "@seosoyoung/soul-ui/cards/card-types";
import { CardCheckItems } from "./CardCheckItems";
import { renderToStaticMarkup } from "react-dom/server";
import { CardImageViewer } from "./CardImageViewer";
import { cardAttachmentSelectionFromEvidence } from "./card-attachment-selection";
import { CardNotes } from "./CardNotes";
import { CardCheckItemRow } from "./CardCheckItemRow";
import { summarizeCardItems } from "./card-item-summary";

const item=(id:number,display:CardCheckItem["display"],extra:Partial<CardCheckItem>={}):CardCheckItem=>({
 id,title:`항목 ${id}`,state:display==="confirmed"?"done":display==="dropped"?"dropped":display==="doing"?"doing":"todo",
 result:null,evidence:[],caveat:null,rev:1,confirmed:display==="confirmed"?{at:"2026-10-05T08:00:00Z",rev:1}:null,
 fixOpen:display==="fix"?2:0,reopened:display==="changed"?"다시 확인할 근거가 있습니다":null,from:null,
 createdAt:"2026-10-05T07:00:00Z",reportedAt:null,display,...extra,
});
const idEvidence=(type:CardItemEvidence["type"],url:string,label:string,attachmentId:string,previewUrl:string|null,originalUrl:string,availability?:CardItemEvidence["availability"]):CardItemEvidence=>({
 type,url,label,attachment_id:attachmentId,
 descriptor:{attachment_id:attachmentId,name:"private-name.png",mime_type:type==="image"?"image/png":"application/pdf",byte_size:512,checksum_sha256:null,width:type==="image"?12:null,height:type==="image"?8:null,preview_kind:type==="image"?"image":"info",preview_mime_type:type==="image"?"image/png":null},
 read_context:{type:"card",id:"card-1"},previewUrl,originalUrl,...(availability?{availability}:{}),
});
it.each(["todo","doing","reported","changed","fix","confirmed","dropped"] as const)("shows missing capture only for a reported result (%s)",display=>{
 const html=renderToStaticMarkup(<CardCheckItemRow item={item(1,display)} checked={false} pending={false} expanded onConfirmChange={()=>{}} onToggleExpanded={()=>{}} onTargetItem={()=>{}} onOpenImage={()=>{}}/>);
 expect(html.includes("캡처 없음")).toBe(display==="reported"||display==="changed");
});
it("keeps the notes heading without repeating its tab count",()=>{
 const html=renderToStaticMarkup(<CardNotes brief="요약" notes={[{id:"n",cardId:"c",authorKind:"agent",authorId:"roselin",sessionId:null,kind:"note",body:"노트",createdAt:"2026-10-05"}]}/>);
 const node=document.createElement("div");node.innerHTML=html;
 expect(node.querySelector(".v3-detail-section-head")?.textContent).toBe("노트");
});
let container:HTMLDivElement,root:Root;
beforeEach(()=>{
 vi.stubGlobal("PointerEvent",MouseEvent);
 (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
 container=document.createElement("div");document.body.append(container);root=createRoot(container);
});
afterEach(async()=>{await act(()=>root.unmount());container.remove();vi.restoreAllMocks();});

it("uses each server display label and leaves dropped title and reason permanently visible",async()=>{
 const items=[item(1,"todo"),item(2,"doing"),item(3,"reported"),item(4,"changed"),item(5,"fix"),item(6,"confirmed"),item(7,"dropped",{result:"요청에서 제외한 까닭"})];
 await act(()=>root.render(<CardCheckItems items={items} onConfirmChange={vi.fn()} onTargetItem={vi.fn()} onOpenImage={vi.fn()}/>));
 for(const [i,label] of ["아직","하는 중","됐다고 보고","다시 봐 주세요","고칠 점 2","확인함","뺌"].entries()) {
  const row=container.querySelector(`[data-item-id="${i+1}"]`)!;
  expect(row.querySelector(".v3-card-check-item-state")).toBeNull();
  expect(row.querySelector('[role="checkbox"]')?.getAttribute("aria-label")).toContain(label);
 }
 const dropped=container.querySelector<HTMLElement>('[data-item-id="7"]')!;
 expect(dropped.querySelector("del")?.textContent).toBe("항목 7");
 expect(dropped.textContent).toContain("요청에서 제외한 까닭");
 expect(dropped.querySelector('[role="checkbox"]')?.hasAttribute("data-disabled")).toBe(true);
});

it("groups only the three initially confirmed rows and keeps new confirmations in place",async()=>{
 const items=[item(1,"confirmed"),item(2,"confirmed"),item(3,"confirmed"),item(4,"todo")];
 await act(()=>root.render(<CardCheckItems items={items} onConfirmChange={vi.fn()} onTargetItem={vi.fn()} onOpenImage={vi.fn()}/>));
 expect(container.querySelector('[data-testid="confirmed-items-group"]')?.textContent).toContain("확인함 3개");
 const item4=container.querySelector<HTMLElement>('[data-item-id="4"]')!;
 await act(()=>item4.querySelector<HTMLElement>('[role="checkbox"]')!.click());
 expect(container.querySelector('[data-testid="confirmed-items-group"]')?.textContent).toContain("확인함 3개");
 expect(container.querySelector('[data-item-id="4"]')).not.toBeNull();
 expect(container.querySelector('[data-testid="confirmed-items-group"] [data-item-id="4"]')).toBeNull();
});

it("sends one confirmation and separates image evidence from link evidence",async()=>{
 const onConfirmChange=vi.fn(),onOpenImage=vi.fn();
 await act(()=>root.render(<CardCheckItems items={[item(8,"reported",{evidence:[{type:"image",url:"/capture.png",label:"실제 화면"},{type:"link",url:"https://example.test/spec",label:"요구사항"}]})]} onConfirmChange={onConfirmChange} onTargetItem={vi.fn()} onOpenImage={onOpenImage}/>));
 const row=container.querySelector<HTMLElement>('[data-item-id="8"]')!;
 expect(row.querySelector('[data-evidence-type="image"] img')).not.toBeNull();
 expect(row.querySelector('[data-evidence-type="link"] a')?.textContent).toBe("요구사항");
 await act(()=>row.querySelector<HTMLElement>('[role="checkbox"]')!.click());
 expect(onConfirmChange).toHaveBeenCalledWith(8,true);
});

it("opens a server-reopened item outside the original confirmed group for this visit",async()=>{
 const renderItems=(items:CardCheckItem[])=>root.render(<CardCheckItems items={items} onConfirmChange={vi.fn()} onTargetItem={vi.fn()}/>);
 const initial=[item(1,"confirmed"),item(2,"confirmed"),item(3,"confirmed")];
 await act(()=>renderItems(initial));
 await act(()=>renderItems([{...item(1,"changed"),result:"수정된 결과입니다"},...initial.slice(1)]));
 const reopened=container.querySelector('[data-item-id="1"]')!;
 expect(reopened.querySelector('.v3-card-check-item-body')).not.toBeNull();
 expect(reopened.closest('[data-testid="confirmed-items-group"]')).toBeNull();
 await act(()=>renderItems(initial));
 expect(container.querySelector('[data-item-id="1"]')?.closest('[data-testid="confirmed-items-group"]')).toBeNull();
 expect(container.querySelector('[data-testid="confirmed-items-group"]')?.textContent).toContain("확인함 2개");
});

it("summarizes the server display values with per-item pending intent",()=>{
 const summary=summarizeCardItems([item(1,"todo"),item(2,"reported"),item(3,"confirmed"),item(4,"dropped")],{1:true,3:false});
 expect(summary.activeItems.map(value=>value.id)).toEqual([2,3]);
 expect(summary.confirmedCount).toBe(1);
 expect(summary.toReviewCount).toBe(1);
});

 it("keeps caveats with results above evidence and labels images without visible captions",async()=>{
  await act(()=>root.render(<CardCheckItems items={[item(8,"reported",{result:"확인 결과",caveat:"실기기 미확인",evidence:[{type:"image",url:"/capture.png",label:"실제 화면"}]})]} onConfirmChange={vi.fn()} onTargetItem={vi.fn()}/>));
  const row=container.querySelector('[data-item-id="8"]')!;
  expect(row.querySelector('.v3-card-check-item-foot .v3-card-check-item-caveat')).toBeNull();
  expect(row.querySelector('.v3-card-check-item-result')!.nextElementSibling?.textContent).toBe("실기기 미확인");
  expect(row.querySelector('figcaption')).toBeNull();
  expect(row.querySelector('figure')?.getAttribute('title')).toBe('실제 화면');
  expect(row.querySelector('img')?.getAttribute('alt')).toBe('실제 화면');
  expect(row.querySelector('.v3-card-check-item-foot .v3-card-check-item-meta')).not.toBeNull();
 });

it("puts the image description below the opened image",async()=>{
 await act(()=>root.render(<CardImageViewer image={{src:"/capture.png",alt:"확인 캡션"}} onClose={vi.fn()}/>));
 expect(document.querySelector('[role="dialog"] figcaption')?.textContent).toBe("확인 캡션");
});
it("frames the handoff and each note separately from the section titles",()=>{
 const html=renderToStaticMarkup(<CardNotes brief="인계 본문" notes={[{id:"n",cardId:"c",authorKind:"agent",authorId:"roselin",sessionId:null,kind:"note",body:"노트 본문",createdAt:"2026-10-05"}]}/>);
 expect(html).toContain('class="v3-card-note-frame"');
 expect(html).toContain('class="v3-card-note-row v3-card-note-frame"');
});
it("does not show missing capture or an empty image block for link-only reported evidence",()=>{
 const html=renderToStaticMarkup(<CardCheckItemRow item={item(1,"reported",{result:"결과",evidence:[{type:"link",url:"/components",label:"증거 링크"}]})} checked={false} pending={false} expanded onConfirmChange={()=>{}} onToggleExpanded={()=>{}} onTargetItem={()=>{}} onOpenImage={()=>{}}/>);
 const node=document.createElement("div");node.innerHTML=html;
 expect(node.textContent).not.toContain("캡처 없음");expect(node.querySelector('[data-evidence-type="image"]')).toBeNull();expect(node.querySelector('[data-evidence-type="link"] a')).not.toBeNull();
});
it("opens a card-scoped preview in the existing dialog and restores the image trigger",async()=>{
 const preview="/api/attachments/image-1/content?context_type=card&context_id=card-1";
 const original=`${preview}&download=true`;
 await act(()=>root.render(<CardCheckItems items={[item(9,"reported",{evidence:[
  idEvidence("image",preview,"검수 화면","image-1",preview,original),
  idEvidence("link",original,"원본 파일","image-1",null,original),
 ]})]} onConfirmChange={vi.fn()} onTargetItem={vi.fn()}/>));
 const row=container.querySelector<HTMLElement>('[data-item-id="9"]')!;
 const thumbnail=row.querySelector<HTMLImageElement>('[data-evidence-type="image"] img')!;
 expect(thumbnail.getAttribute("src")).toBe(preview);
 expect(row.querySelector<HTMLAnchorElement>('[data-evidence-type="link"] a')?.getAttribute("href")).toBe(original);
 expect(row.querySelector('[data-evidence-type="link"] a')?.getAttribute("target")).toBe("_blank");
 expect(row.textContent).not.toContain("private-name.png");
 expect(row.textContent).not.toContain("512");
 vi.stubGlobal("requestAnimationFrame",(callback:FrameRequestCallback)=>{callback(0);return 0;});
 thumbnail.focus();
 await act(()=>thumbnail.click());
 expect(document.body.querySelector<HTMLImageElement>('[role="dialog"] img')?.getAttribute("src")).toBe(preview);
 await act(()=>document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true})));
 expect(document.body.querySelector('[role="dialog"]')).toBeNull();
 expect(document.activeElement).toBe(thumbnail);
 expect(row.querySelector(".v3-card-check-item-title-button")?.getAttribute("aria-expanded")).toBe("true");
});
it("shows unavailable evidence in the existing empty-image surface and keeps other proof",async()=>{
 const external="https://example.test/spec";
 await act(()=>root.render(<CardCheckItems items={[item(10,"reported",{evidence:[
  idEvidence("image","","이미지 근거","missing-image",null,"","missing"),
  idEvidence("link","","첨부 링크","missing-link",null,"","unavailable"),
  {type:"link",url:external,label:"외부 요구사항"},
 ]})]} onConfirmChange={vi.fn()} onTargetItem={vi.fn()}/>));
 const row=container.querySelector<HTMLElement>('[data-item-id="10"]')!;
 expect(row.querySelector('[data-evidence-type="image"] img')).toBeNull();
 expect(row.querySelectorAll(".v3-card-check-item-no-image")).toHaveLength(2);
 expect([...row.querySelectorAll(".v3-card-check-item-no-image")].map(node=>node.textContent)).toEqual(["파일을 불러오지 못했습니다","파일을 불러오지 못했습니다"]);
 const externalLink=row.querySelector<HTMLAnchorElement>('[data-evidence-type="link"] a[href="https://example.test/spec"]')!;
 expect(externalLink.textContent).toBe("외부 요구사항");
 expect(externalLink.target).toBe("_blank");
 expect(row.querySelectorAll('[data-evidence-type="link"] a')).toHaveLength(1);
 expect(row.textContent).not.toContain("private-name.png");
});
it("replaces a thumbnail whose bytes fail to load with the failure text",async()=>{
 await act(()=>root.render(<CardCheckItems items={[item(11,"reported",{evidence:[
  idEvidence("image","/broken.png","읽기 실패 화면","broken-image","/broken.png","/broken.png&download=true"),
  idEvidence("image","/ready.png","등록한 화면","ready-image","/ready.png","/ready.png&download=true"),
 ]})]} onConfirmChange={vi.fn()} onTargetItem={vi.fn()}/>));
 const row=container.querySelector<HTMLElement>('[data-item-id="11"]')!;
 const broken=row.querySelector<HTMLImageElement>('[data-evidence-type="image"] img[src="/broken.png"]')!;
 await act(()=>broken.dispatchEvent(new Event("error")));
 expect(row.querySelector('[data-evidence-type="image"] img[src="/broken.png"]')).toBeNull();
 expect([...row.querySelectorAll(".v3-card-check-item-no-image")].map(node=>node.textContent)).toEqual(["파일을 불러오지 못했습니다"]);
 expect(row.querySelector('[data-evidence-type="image"] img[src="/ready.png"]')).not.toBeNull();
 const imageRow=row.querySelector('[data-evidence-type="image"]')!;
 expect(imageRow.lastElementChild?.textContent).toBe("파일을 불러오지 못했습니다");
});
it("collapses several failed attachments in one row into one failure text at the row end",async()=>{
 await act(()=>root.render(<CardCheckItems items={[item(12,"reported",{evidence:[
  idEvidence("image","","지워진 화면","gone-1",null,"","missing"),
  idEvidence("image","/ok.png","정상 화면","ok-1","/ok.png","/ok.png&download=true"),
  idEvidence("image","","올리는 중","gone-2",null,"","unavailable"),
  idEvidence("link","","지워진 파일","gone-3",null,"","missing"),
  {type:"link",url:"https://example.test/a",label:"외부 링크"},
  idEvidence("link","","올리는 중인 파일","gone-4",null,"","unavailable"),
 ]})]} onConfirmChange={vi.fn()} onTargetItem={vi.fn()}/>));
 const row=container.querySelector<HTMLElement>('[data-item-id="12"]')!;
 const imageRow=row.querySelector('[data-evidence-type="image"]')!;
 const linkRow=row.querySelector('[data-evidence-type="link"]')!;
 expect(imageRow.querySelectorAll(".v3-card-check-item-no-image")).toHaveLength(1);
 expect(imageRow.lastElementChild?.textContent).toBe("파일을 불러오지 못했습니다");
 expect(imageRow.querySelectorAll("img")).toHaveLength(1);
 expect(linkRow.querySelectorAll(".v3-card-check-item-no-image")).toHaveLength(1);
 expect(linkRow.lastElementChild?.textContent).toBe("파일을 불러오지 못했습니다");
 expect(linkRow.querySelectorAll("a")).toHaveLength(1);
});
it("hides a failed preview in the viewer and keeps only the caption error",async()=>{
 const onClose=vi.fn();
 await act(()=>root.render(<CardImageViewer image={{src:"/gone.png",alt:"없는 이미지"}} onClose={onClose}/>));
 await act(()=>document.body.querySelector<HTMLImageElement>('[role="dialog"] img')!.dispatchEvent(new Event("error")));
 expect(document.body.querySelector('[role="dialog"] img')).toBeNull();
 expect(document.body.querySelector('[role="dialog"] figcaption')?.textContent).toBe("파일을 불러오지 못했습니다");
 expect(document.body.querySelector('[role="dialog"] figure')?.hasAttribute("data-image-failed")).toBe(true);
});
it("shows preview load errors in the caption and clears them for a new source",async()=>{
 const onClose=vi.fn();
 const render=(src:string,alt:string)=>root.render(<CardImageViewer image={{src,alt}} onClose={onClose}/>);
 await act(()=>render("/first.png","첫 이미지"));
 const first=document.body.querySelector<HTMLImageElement>('[role="dialog"] img')!;
 await act(()=>first.dispatchEvent(new Event("error")));
 expect(document.body.querySelector('[role="dialog"] figcaption')?.textContent).toBe("파일을 불러오지 못했습니다");
 await act(()=>render("/second.png","다음 이미지"));
 expect(document.body.querySelector<HTMLImageElement>('[role="dialog"] img')?.getAttribute("src")).toBe("/second.png");
 expect(document.body.querySelector('[role="dialog"] figcaption')?.textContent).toBe("다음 이미지");
 await act(()=>render("/first.png","첫 이미지"));
 expect(document.body.querySelector('[role="dialog"] figcaption')?.textContent).toBe("첫 이미지");
});
it.each(["todo","doing","fix"] as const)("does not render an empty evidence slot between result and footer (%s)",display=>{
 const html=renderToStaticMarkup(<CardCheckItemRow item={item(1,display,{result:"결과",caveat:display==="fix"?"못 본 것":null})} checked={false} pending={false} expanded onConfirmChange={()=>{}} onToggleExpanded={()=>{}} onTargetItem={()=>{}} onOpenImage={()=>{}}/>);
 const node=document.createElement("div");node.innerHTML=html;expect(node.querySelector('[data-evidence-type="image"]')).toBeNull();
});

it("projects card evidence into the card-scoped chat attachment model",()=>{
 const preview="/api/attachments/image-1/content?context_type=card&context_id=card-1";
 const original=`${preview}&download=true`;
 expect(cardAttachmentSelectionFromEvidence(idEvidence("image",preview,"화면","image-1",preview,original))).toMatchObject({
  key:"asset:image-1",name:"private-name.png",mimeType:"image/png",byteSize:512,previewKind:"image",availability:"ready",
  previewUrl:preview,originalUrl:original,source:{kind:"asset",attachmentId:"image-1",context:{type:"card",id:"card-1"}},
 });
 expect(cardAttachmentSelectionFromEvidence(idEvidence("image","","없어진 화면","gone",null,"","missing"))).toMatchObject({
  key:"asset:gone",availability:"missing",previewUrl:null,originalUrl:null,source:{kind:"unavailable",attachmentId:"gone",context:{type:"card",id:"card-1"}},
 });
 expect(cardAttachmentSelectionFromEvidence({type:"link",url:"https://example.test/file.txt",label:"외부 파일"})).toBeNull();
});

it("opens one item's internal evidence in the shared viewer in evidence order",async()=>{
 const imagePreview="/api/attachments/image-1/content?context_type=card&context_id=card-1";
 const textPreview="/api/attachments/text-1/content?context_type=card&context_id=card-1";
 const textEvidence=idEvidence("link",`${textPreview}&download=true`,"두 번째 증거","text-1",textPreview,`${textPreview}&download=true`);
 textEvidence.descriptor={...textEvidence.descriptor!,name:"notes.txt",mime_type:"text/plain",preview_kind:"text",preview_mime_type:"text/plain"};
 const evidence=[
  idEvidence("image",imagePreview,"첫 증거","image-1",imagePreview,`${imagePreview}&download=true`),
  textEvidence,
  {type:"link" as const,url:"https://example.test/spec",label:"외부 요구사항"},
 ];
 vi.stubGlobal("fetch",vi.fn(async()=>{
  const previewBytes=new TextEncoder().encode("본문 미리보기");
  const body=new Uint8Array(512);body.set(previewBytes);body.fill(32,previewBytes.length);
  return new Response(body,{status:206,headers:{"content-type":"text/plain; charset=utf-8","content-length":"512","content-range":"bytes 0-511/512"}});
 }));
 await act(()=>root.render(<CardCheckItems items={[item(14,"reported",{evidence})]} onConfirmChange={vi.fn()} onTargetItem={vi.fn()}/>));
 const row=container.querySelector<HTMLElement>('[data-item-id="14"]')!;
 const trigger=row.querySelector<HTMLImageElement>('[data-evidence-type="image"] img')!;
 trigger.focus();
 await act(()=>trigger.click());
 let viewer=document.body.querySelector<HTMLElement>(".chat-image-viewer-popup")!;
 expect(viewer.querySelector(".chat-image-viewer-title")?.textContent).toBe("private-name.png");
 expect(viewer.querySelector<HTMLImageElement>("img")?.getAttribute("src")).toBe(imagePreview);
 expect(viewer.querySelector(".chat-image-viewer-count")?.textContent).toBe("1/2");
 await act(async()=>{viewer.querySelector<HTMLButtonElement>('[aria-label="다음 첨부"]')!.click();await new Promise(resolve=>setTimeout(resolve,0));});
 viewer=document.body.querySelector<HTMLElement>(".chat-image-viewer-popup")!;
 expect(viewer.querySelector(".chat-image-viewer-title")?.textContent).toBe("notes.txt");
 expect(viewer.querySelector(".chat-image-viewer-count")?.textContent).toBe("2/2");
 expect(viewer.textContent).toContain("본문 미리보기");
 expect(row.querySelector<HTMLAnchorElement>('[href="https://example.test/spec"]')?.target).toBe("_blank");
 await act(()=>document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true})));
 expect(document.activeElement).toBe(trigger);
});

it("R1 reads text evidence from the real server projection with previewUrl null",async()=>{
 const url="/api/attachments/text-projection/content?context_type=card&context_id=card-1";
 const evidence=idEvidence("link",`${url}&download=true`,"텍스트 증거","text-projection",null,`${url}&download=true`);
 evidence.descriptor={...evidence.descriptor!,name:"실제.txt",mime_type:"text/plain",byte_size:6,preview_kind:"text",preview_mime_type:"text/plain"};
 const fetchMock=vi.fn(async()=>new Response("server",{status:206,headers:{"content-length":"6","content-range":"bytes 0-5/6"}}));
 vi.stubGlobal("fetch",fetchMock);
 expect(cardAttachmentSelectionFromEvidence(evidence)?.previewUrl).toBe(url);
 await act(()=>root.render(<CardCheckItems items={[item(1,"reported",{evidence:[evidence]})]} onConfirmChange={()=>{}} onTargetItem={()=>{}}/>));
 await act(async()=>{container.querySelector<HTMLAnchorElement>('[data-evidence-type="link"] a')!.click();await new Promise(resolve=>setTimeout(resolve,0));});
 expect(document.body.querySelector(".chat-image-viewer-popup pre")?.textContent).toBe("server");
 expect(fetchMock).toHaveBeenCalledWith(url,expect.objectContaining({credentials:"same-origin"}));
});

it("R3 navigates mixed evidence in the row's image-then-link display order",async()=>{
 const evidence=[
  idEvidence("link","/one","파일 1","file-one",null,"/one"),
  idEvidence("image","/image-one","이미지 1","image-one","/image-one","/image-one"),
  idEvidence("link","/two","파일 2","file-two",null,"/two"),
  idEvidence("image","/image-two","이미지 2","image-two","/image-two","/image-two"),
 ];
 evidence.forEach(value=>{value.descriptor={...value.descriptor!,name:value.label};});
 await act(()=>root.render(<CardCheckItems items={[item(1,"reported",{evidence})]} onConfirmChange={()=>{}} onTargetItem={()=>{}}/>));
 await act(()=>container.querySelector<HTMLImageElement>('img')!.click());
 expect(document.body.querySelector(".chat-image-viewer-count")?.textContent).toBe("1/4");
 await act(()=>document.body.querySelector<HTMLButtonElement>('[aria-label="다음 첨부"]')!.click());
 expect(document.body.querySelector(".chat-image-viewer-title")?.textContent).toBe("이미지 2");
 expect(document.body.querySelector(".chat-image-viewer-count")?.textContent).toBe("2/4");
});

it.each(["missing","unavailable"] as const)("R5 preserves the evidence label without a descriptor (%s)",availability=>{
 const evidence:CardItemEvidence={type:"link",url:"",label:"지워진 자료.txt",attachment_id:"gone",read_context:{type:"card",id:"card-1"},availability,previewUrl:null,originalUrl:""};
 expect(cardAttachmentSelectionFromEvidence(evidence)).toMatchObject({name:"지워진 자료.txt",availability,previewUrl:null,originalUrl:null});
});
