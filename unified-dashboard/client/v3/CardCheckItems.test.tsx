/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CardCheckItem, CardItemEvidence } from "@seosoyoung/soul-ui/cards/card-types";
import { CardCheckItems } from "./CardCheckItems";
import { renderToStaticMarkup } from "react-dom/server";
import { CardImageViewer } from "./CardImageViewer";
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
