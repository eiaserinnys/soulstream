import {test,expect,type Page} from "@playwright/test";
import {mkdirSync,writeFileSync} from "node:fs";
import path from "node:path";
import {installV3VisualQaRoutes} from "./v3-visual-fixtures";
import {reviewCard,reviewTitle} from "../client/v3/components-review-fixtures";
import {DEFAULT_USER_PREFERENCES} from "../../packages/soul-ui/src/lib/user-preferences";
const output=path.resolve("../../../.local/artifacts/20261002-card-home-web");
const seed=()=>["todo","queued","running","blocked","review","done"].flatMap((status,index)=>Array.from({length:index===0?4:1},(_,copy)=>({...reviewCard,id:`home-${index}-${copy}`,folderId:"folder-amber",status:status as typeof reviewCard.status,
 title:status==="todo"?reviewTitle:`${status} 카드`,latestActivity:{kind:status==="todo"?"instruction" as const:"report" as const,format:"markdown" as const,body:"긴 한국어 원문과 제목이 있어도 열과 카드 폭을 유지합니다. 마지막 지시와 보고는 카드 상세에서 이어 봅니다. ".repeat(6),createdAt:reviewCard.createdAt}})));
async function fixture(page:Page,fontSize=17){
 const cards=seed(),reads:string[]=[],creates:Record<string,unknown>[]=[],writes:{id:string;body:Record<string,unknown>}[]=[];
 let failure=false,delay=false;
 await page.addInitScript(()=>{localStorage.setItem("ls.webglGlass","0");Object.defineProperty(navigator.serviceWorker,"register",{configurable:true,value:async()=>({update:async()=>{},active:null,addEventListener:()=>{}})});
  const Native=EventSource,sources:EventSource[]=[];let sequence=0;
  window.EventSource=class extends Native{constructor(url:string|URL,options?:EventSourceInit){super(url,options);sources.push(this);}};
  Object.assign(window,{emitCard:(cardId:string)=>sources.filter(source=>source.url.includes("/api/sessions/stream")).forEach(source=>source.dispatchEvent(new MessageEvent("card_updated",{data:JSON.stringify({type:"card_updated",cardId,folderId:"folder-amber"}),lastEventId:`card-home-${++sequence}`})))});
 });
 await installV3VisualQaRoutes(page,{unifiedFolderView:true,postitCards:cards});
 await page.route("**/api/auth/config",route=>route.fulfill({json:{authEnabled:true,devModeEnabled:false}}));
 await page.route("**/api/auth/status",route=>route.fulfill({json:{authenticated:true,user:{email:"home@example.test",name:"검수"}}}));
 await page.route("**/api/user/preferences",route=>route.fulfill({json:{email:"home@example.test",preferences:{...DEFAULT_USER_PREFERENCES,chatFontSize:fontSize},hasBackground:false}}));
 await page.route("**/api/cards",async route=>{
  if(route.request().method()==="GET")return route.fulfill({json:{cards}});
  const body=route.request().postDataJSON();creates.push(body);
  if(failure)return route.fulfill({status:409,json:{message:"fixture create conflict"}});
  const card={...reviewCard,id:"created",folderId:body.folderId,title:body.title,request:body.request,status:"todo" as const};cards.push(card);return route.fulfill({status:201,json:{card}});
 });
 await page.route("**/api/cards/**",async route=>{
  const request=route.request(),parts=new URL(request.url()).pathname.split("/"),card=cards.find(card=>card.id===parts[3]);
  if(!card)return route.fulfill({status:404,json:{message:"fixture 카드 없음"}});
  if(request.method()==="POST"){
   const body=request.postDataJSON();writes.push({id:card.id,body});
   if(delay)await new Promise(done=>setTimeout(done,600));
   if(failure)return route.fulfill({status:409,json:{message:"fixture version conflict"}});
   if(body.expectedVersion!==card.version)return route.fulfill({status:409,json:{message:"expectedVersion 불일치"}});
   card.status=body.status;card.version++;
  }else reads.push(card.id);
  return route.fulfill({json:{card,reports:[{id:"report",title:"보고",body:"보고",format:"markdown",createdAt:card.createdAt,sessionId:null}],
   questions:card.id==="home-3-0"?[{id:"q",text:"질문",answer:null,options:null,askedAt:"",answeredAt:null}]:[],sessions:[]}});
 });
 await page.goto("/");await expect(page.getByTestId("card-home")).toBeVisible();
 const board=page.getByTestId("card-home").locator(".v3-card-board");await expect(board.locator("[data-board-column]")).toHaveCount(6);
 return {cards,reads,writes,creates,board,setFailure:(value:boolean)=>{failure=value;},setDelay:(value:boolean)=>{delay=value;}};
}
const boardTarget=(page:Page)=>page.locator('.v3-card-board-column[data-board-column="queued"]');
const capture=async(page:Page,name:string)=>{mkdirSync(output,{recursive:true});await page.screenshot({path:path.join(output,`${name}.png`),animations:"disabled"});};
for(const [width,font] of [[390,17],[1210,14],[1440,17],[1920,18]])test(`product layout ${width} font ${font}`,async({page})=>{
 await page.setViewportSize({width,height:width===1210?834:1000});await page.emulateMedia({reducedMotion:"reduce"});
 const state=await fixture(page,font),home=page.getByTestId("card-home");await page.evaluate(()=>document.fonts.ready);
 expect(state.reads).toEqual([]);await expect(home.locator('[data-card-status="done"]')).toHaveCount(1);
 const metrics=await state.board.evaluate(element=>({width:element.clientWidth,scroll:element.scrollWidth,
  heads:[...element.querySelectorAll(".v3-card-board-column > .v3-detail-section-head")].map(node=>{const h=node.querySelector("h3")!.getBoundingClientRect(),c=node.querySelector("span")!.getBoundingClientRect();return {title:h.y,count:c.y,centerDelta:Math.abs(h.y+h.height/2-c.y-c.height/2)};}),
  card:[...element.querySelectorAll<HTMLElement>(".v3-postit-card")].map(card=>({width:parseFloat(getComputedStyle(card).width),height:parseFloat(getComputedStyle(card).height),font:parseFloat(getComputedStyle(card.querySelector(".v3-postit-body")!).fontSize)})),
  composerVisible:document.querySelector(".v3-today-handoff")!.getBoundingClientRect().bottom<=innerHeight}));
 expect(metrics.scroll).toBeGreaterThan(metrics.width);expect(metrics.composerVisible).toBe(true);
 for(const head of metrics.heads)expect(head.centerDelta).toBeLessThanOrEqual(1);
 for(const card of metrics.card){expect(card.width/card.height).toBeCloseTo(320/280,2);expect(card.font).toBe(font);}
 await capture(page,`after-home-${width}-font${font}`);
 await state.board.evaluate(el=>el.scrollLeft=Math.min(250,el.scrollWidth-el.clientWidth));
 const old=await state.board.evaluate(el=>el.scrollLeft);const expand=home.getByRole("button",{name:"보드 확대",exact:true});await expand.click();
 const dialog=page.getByRole("dialog",{name:"전체 카드 보드",exact:true});await expect(dialog).toBeVisible();
 const expandedRect=await dialog.evaluate(el=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};});
 expect(expandedRect).toEqual({x:20,y:20,width:width-40,height:(width===1210?834:1000)-40});
 await capture(page,`after-expanded-${width}-font${font}`);await dialog.locator(".v3-card-board").evaluate(el=>el.scrollLeft=el.scrollWidth);
 await page.keyboard.press("Escape");await expect(dialog).toHaveCount(0);expect(await state.board.evaluate(el=>el.scrollLeft)).toBe(old);await expect(expand).toBeFocused();
 await home.getByRole("button",{name:"기록",exact:true}).click();await expect(page.locator(".v3-date-head")).toBeVisible();
 if(width===390)await page.getByTestId("v3-mobile-tab-today").click();else await page.getByRole("button",{name:"전체 카드",exact:true}).click();
 await expect(home).toBeVisible();
 if(width===390){await page.getByTestId("v3-mobile-tab-projects").click();await page.getByTestId("v3-mobile-project-list").getByRole("button",{name:"소울스트림",exact:true}).click();}
 else await page.getByTestId("v3-all-projects").getByRole("button",{name:"소울스트림",exact:true}).click();
 const folder=page.getByTestId("folder-card-section");await folder.scrollIntoViewIfNeeded();await expect(folder.locator('[data-card-status="done"]')).toHaveCount(0);
 await capture(page,`after-folder-${width}-font${font}`);
 const review=folder.locator('[data-card-id="home-4-0"]');await review.scrollIntoViewIfNeeded();await review.click({button:"right"});
 await page.locator("[data-card-status-picker]").getByRole("button",{name:"완료",exact:true}).click();
 await expect(folder.locator('[data-card-id="home-4-0"]')).toHaveCount(0);await expect(folder).toContainText("완료 2개 숨김");
 await folder.getByRole("button",{name:"완료 포함 켜기",exact:true}).click();await expect(folder.locator('[data-card-status="done"]')).toHaveCount(2);
 expect(state.writes).toHaveLength(1);writeFileSync(path.join(output,`metrics-${width}-font${font}.json`),JSON.stringify({metrics,expandedRect,restoredHorizontal:old,reads:state.reads,writes:state.writes},null,2));
});

test("keyboard and pointer lane moves share latest guards and awaited fixture writes",async({page})=>{
 await page.setViewportSize({width:1440,height:1000});const state=await fixture(page);
 const draft=state.board.locator('[data-card-id="home-0-0"]');
 const grip=draft.getByRole("button",{name:`${reviewTitle} 단계 이동`,exact:true});await grip.focus();await page.keyboard.press("Space");await expect(state.board.locator(".is-dragging")).toHaveCount(1);await expect(state.board.locator('[data-board-column="todo"]')).toHaveClass(/is-drop-target/);await page.keyboard.press("ArrowRight");await expect(boardTarget(page)).toHaveClass(/is-drop-target/);await page.keyboard.press("Space");
 await expect(state.board.locator('[data-board-column="queued"] [data-card-id="home-0-0"]')).toHaveCount(1);expect(state.writes).toHaveLength(1);expect(state.writes[0].body).toMatchObject({status:"queued",expectedVersion:reviewCard.version});
 await expect(state.board.locator('[data-board-column="todo"] [data-card-id="home-0-0"]')).toHaveCount(0);await expect(state.board.locator(".is-dragging")).toHaveCount(0);
 writeFileSync(path.join(output,"keyboard-saved.json"),JSON.stringify(state.writes,null,2));await page.reload();await expect(state.board.locator('[data-board-column="queued"] [data-card-id="home-0-0"]')).toHaveCount(1);
 await page.getByRole("button",{name:"보드 확대",exact:true}).click();const board=page.getByRole("dialog",{name:"전체 카드 보드"}).locator(".v3-card-board");
 await board.evaluate(el=>el.scrollLeft=el.scrollWidth);const review=board.locator('[data-card-id="home-4-0"]');
 const source=await review.getByRole("button",{name:"review 카드 단계 이동",exact:true}).boundingBox();const target=await board.locator('[data-board-column="done"]').boundingBox();
 await page.mouse.move(source!.x+source!.width/2,source!.y+source!.height/2);await page.mouse.down();await page.mouse.move(target!.x+target!.width/2,target!.y+100,{steps:15});await page.mouse.up();
 await expect(board.locator('[data-board-column="done"] [data-card-id="home-4-0"]')).toHaveCount(1);
 await expect(board.locator('[data-board-column="review"] [data-card-id="home-4-0"]')).toHaveCount(0);expect(state.writes).toHaveLength(2);writeFileSync(path.join(output,"pointer-saved.json"),JSON.stringify(state.writes,null,2));
 // Shift+F10 is the same menu as right click; the reason stays after a failed save.
 const done=board.locator('[data-card-id="home-4-0"]');await done.locator(".v3-postit-open").focus();await page.keyboard.press("Shift+F10");await expect(page.locator("[data-card-status-picker]")).toBeVisible();await page.keyboard.press("Escape");
 await expect(page.locator("[data-card-status-picker]")).toHaveCount(0);await expect(page.getByRole("dialog",{name:"전체 카드 보드"})).toBeVisible();await expect(page.getByTestId("card-detail")).toHaveCount(0);
 await page.keyboard.press("Escape");await expect(page.getByRole("dialog",{name:"전체 카드 보드"})).toHaveCount(0);await expect(page.getByRole("button",{name:"보드 확대",exact:true})).toBeFocused();
 const blocked=state.board.locator('[data-card-id="home-3-0"]');await blocked.scrollIntoViewIfNeeded();await blocked.click({button:"right"});
 const picker=page.locator("[data-card-status-picker]");await expect(picker).not.toContainText("질문에 답한 뒤 변경할 수 있습니다");await expect(picker.getByRole("button",{name:"완료",exact:true})).toBeEnabled();await page.keyboard.press("Escape");
 expect(state.writes).toHaveLength(2);await capture(page,"after-drag-and-guards");writeFileSync(path.join(output,"drag.json"),JSON.stringify({reads:state.reads,writes:state.writes},null,2));
});

test("actual component samples support keyboard moves and expansion without API writes",async({page})=>{
 await page.setViewportSize({width:1210,height:834});await fixture(page,17);const writes:string[]=[];page.on("request",r=>{if(r.method()!=="GET"&&new URL(r.url()).pathname.startsWith("/api/cards"))writes.push(r.url());});
 await page.goto("/components");const sample=page.getByTestId("card-board-sample");const board=sample.locator(".v3-card-board");await board.scrollIntoViewIfNeeded();
 const draft=board.locator('[data-card-id="board-0-0"]');await draft.getByRole("button",{name:`${reviewTitle} 단계 이동`,exact:true}).focus();
 await page.keyboard.press("Space");await expect(board.locator(".is-dragging")).toHaveCount(1);await page.keyboard.press("ArrowRight");await expect(boardTarget(page)).toHaveClass(/is-drop-target/);await page.keyboard.press("Space");
 await expect(board.locator('[data-board-column="queued"] [data-card-id="board-0-0"]')).toHaveCount(1);
 const originalScroll=await board.evaluate(el=>el.scrollLeft);
 await sample.getByRole("button",{name:"보드 확대",exact:true}).click();const expanded=page.getByRole("dialog",{name:"현재 폴더 카드 보드"});await expect(expanded).toBeVisible();
 const bounds=await expanded.evaluate(el=>{const rect=el.getBoundingClientRect();return {x:rect.x,y:rect.y,width:rect.width,height:rect.height,centerOwned:el.contains(document.elementFromPoint(innerWidth/2,innerHeight/2))};});expect(bounds).toEqual({x:20,y:20,width:1170,height:794,centerOwned:true});writeFileSync(path.join(output,"components-expanded-metrics.json"),JSON.stringify(bounds,null,2));await capture(page,"after-components-expanded");await expanded.getByRole("switch",{name:/완료 포함/}).click();await expect(expanded.getByRole("switch",{name:/완료 포함/})).toBeChecked();await expanded.locator(".v3-card-board").evaluate(el=>el.scrollLeft=el.scrollWidth);
 await page.keyboard.press("Escape");expect(await board.evaluate(el=>el.scrollLeft)).toBe(originalScroll);await expect(sample.locator('.v3-card-board-workspace').getByRole("switch",{name:/완료 포함/})).not.toBeChecked();await expect(sample.getByRole("button",{name:"보드 확대",exact:true})).toBeFocused();expect(writes).toEqual([]);
});


test("Escape owns only the current reason/menu or drag; outside drops and cancel write zero",async({page})=>{
 await page.setViewportSize({width:1210,height:834});const state=await fixture(page);
 await page.getByRole("button",{name:"보드 확대",exact:true}).click();const dialog=page.getByRole("dialog",{name:"전체 카드 보드"}),board=dialog.locator(".v3-card-board");
 const review=board.locator('[data-card-id="home-4-0"]');await review.scrollIntoViewIfNeeded();await review.click({button:"right"});
 const picker=page.locator("[data-card-status-picker]");await picker.getByRole("button",{name:"실행 중",exact:true}).click();await picker.getByRole("textbox",{name:"다시 실행할 사유"}).fill("입력 중 취소");
 await page.keyboard.press("Escape");await expect(picker).toHaveCount(0);await expect(dialog).toBeVisible();expect(state.writes).toHaveLength(0);await expect(page.getByTestId("card-detail")).toHaveCount(0);
 await board.evaluate(el=>el.scrollLeft=0);const grip=board.locator('[data-card-id="home-0-0"]').getByRole("button",{name:`${reviewTitle} 단계 이동`,exact:true});await grip.focus();await page.keyboard.press("Space");await expect(board.locator(".is-dragging")).toHaveCount(1);
 await page.keyboard.press("ArrowRight");await expect(dialog.locator('[data-board-column="queued"]')).toHaveClass(/is-drop-target/);await page.keyboard.press("Escape");await expect(board.locator(".is-dragging")).toHaveCount(0);await expect(dialog).toBeVisible();expect(state.writes).toHaveLength(0);
 await board.evaluate(el=>el.scrollLeft=0);const source=await grip.boundingBox(),header=await dialog.locator(".v3-folder-card-head").boundingBox();
 await page.mouse.move(source!.x+source!.width/2,source!.y+source!.height/2);await page.mouse.down();await page.mouse.move(header!.x+100,header!.y+10,{steps:10});await page.mouse.up();await expect(board.locator(".is-dragging")).toHaveCount(0);expect(state.writes).toHaveLength(0);
 await page.keyboard.press("Escape");await expect(dialog).toHaveCount(0);await expect(page.getByRole("button",{name:"보드 확대",exact:true})).toBeFocused();
 writeFileSync(path.join(output,"cancel.json"),JSON.stringify({writes:state.writes,cardDetailOpened:false},null,2));
});

test("new drafts and SSE membership appear without re-entry and preserve failed input",async({page})=>{
 await page.setViewportSize({width:1440,height:1000});const state=await fixture(page);await page.getByTestId("card-home").getByRole("button",{name:"새 카드",exact:true}).click();
 const dialog=page.getByRole("dialog");await dialog.getByRole("textbox",{name:"카드 제목"}).fill("저장할 드래프트");await dialog.getByRole("textbox",{name:"요청 원문"}).fill("지시 원문");await dialog.getByRole("button",{name:"폴더 선택",exact:true}).click();await page.locator('.v3-card-folder-picker').getByRole("tab",{name:"전체",exact:true}).click();await page.locator('.v3-card-folder-picker').getByRole("button",{name:"소울스트림",exact:true}).click();
 state.setFailure(true);await dialog.getByRole("button",{name:"카드 저장"}).click();await expect(dialog.getByRole("alert")).toContainText("fixture create conflict");await expect(dialog.getByRole("textbox",{name:"카드 제목"})).toHaveValue("저장할 드래프트");expect(state.creates[0].queue).toBe(false);
 state.setFailure(false);await dialog.getByRole("button",{name:"카드 저장"}).click();await expect(state.board.locator('[data-card-id="created"]')).toHaveCount(1);expect(state.creates[1].queue).toBe(false);
 const added={...reviewCard,id:"external",folderId:"folder-amber",title:"다른 세션의 새 카드",status:"todo" as const};state.cards.push(added);
 await page.evaluate(()=>{(window as unknown as {emitCard(id:string):void}).emitCard("external");(window as unknown as {emitCard(id:string):void}).emitCard("external");});
 await expect(state.board.locator('[data-card-id="external"]')).toHaveCount(1);await expect(page.getByTestId("card-home").locator('.v3-folder-card-head')).toContainText("11개");
 state.cards.splice(state.cards.findIndex(card=>card.id==="external"),1);await page.evaluate(()=>(window as unknown as {emitCard(id:string):void}).emitCard("external"));await expect(state.board.locator('[data-card-id="external"]')).toHaveCount(0);await expect(page.getByTestId("card-home").locator('.v3-folder-card-head')).toContainText("10개");
 writeFileSync(path.join(output,"membership.json"),JSON.stringify({creates:state.creates,duplicates:0,removed:true},null,2));await capture(page,"after-created-and-sse");
});


test("narrow keyboard scrolling settles on the saved lane before reload",async({page})=>{
 await page.setViewportSize({width:1210,height:834});const state=await fixture(page,14);
 const grip=state.board.locator('[data-card-id="home-0-0"]').getByRole("button",{name:`${reviewTitle} 단계 이동`,exact:true});await grip.focus();await page.keyboard.press("Space");await expect(state.board.locator(".is-dragging")).toHaveCount(1);
 const origin=await state.board.locator('[data-card-id="home-0-0"]').locator('..').boundingBox(),overlay=await page.locator('.v3-card-board-drag-overlay').boundingBox();expect(Math.abs(origin!.x-overlay!.x)).toBeLessThanOrEqual(1);expect(Math.abs(origin!.y-overlay!.y)).toBeLessThanOrEqual(1);
 await page.keyboard.press("ArrowRight");await expect(state.board.locator('[data-board-column="queued"]')).toHaveClass(/is-drop-target/);await page.keyboard.press("Space");
 await expect(state.board.locator('[data-board-column="queued"] [data-card-id="home-0-0"]')).toHaveCount(1);await expect(state.board.locator('[data-board-column="todo"] [data-card-id="home-0-0"]')).toHaveCount(0);expect(state.writes).toHaveLength(1);expect(state.writes[0].body).toMatchObject({status:"queued",expectedVersion:reviewCard.version});
 await page.reload();await expect(state.board.locator('[data-board-column="queued"] [data-card-id="home-0-0"]')).toHaveCount(1);writeFileSync(path.join(output,"keyboard-narrow-saved.json"),JSON.stringify({writes:state.writes,reloaded:true,origin,overlay},null,2));
});

test("pointer edge scrolling reaches the last lane and commits once",async({page})=>{
 await page.setViewportSize({width:1440,height:1000});const state=await fixture(page);const grip=state.board.locator('[data-card-id="home-0-0"]').getByRole("button",{name:`${reviewTitle} 단계 이동`,exact:true}),source=await grip.boundingBox(),boardRect=await state.board.boundingBox();
 await page.mouse.move(source!.x+source!.width/2,source!.y+source!.height/2);await page.mouse.down();await page.mouse.move(boardRect!.x+boardRect!.width-10,source!.y+source!.height/2,{steps:15});await expect(state.board.locator(".is-dragging")).toHaveCount(1);
 await expect.poll(()=>state.board.evaluate(el=>el.scrollLeft),{timeout:10000}).toBeGreaterThan(1000);
 const done=await state.board.locator('[data-board-column="done"]').boundingBox();await page.mouse.move(Math.min(done!.x+done!.width/2,boardRect!.x+boardRect!.width-20),done!.y+100,{steps:5});await expect(state.board.locator('[data-board-column="done"]')).toHaveClass(/is-drop-target/);await page.mouse.up();
 await expect(state.board.locator('[data-board-column="done"] [data-card-id="home-0-0"]')).toHaveCount(1);expect(state.writes).toHaveLength(1);await expect(page.getByTestId("card-detail")).toHaveCount(0);writeFileSync(path.join(output,"edge-scroll.json"),JSON.stringify({scrollLeft:await state.board.evaluate(el=>el.scrollLeft),writes:state.writes},null,2));
});

test("pending and failed status saves retain the reason and block duplicate writes",async({page})=>{
 await page.setViewportSize({width:1440,height:1000});const state=await fixture(page),review=state.board.locator('[data-card-id="home-4-0"]');await review.scrollIntoViewIfNeeded();await review.click({button:"right"});const picker=page.locator('[data-card-status-picker]');await picker.getByRole("button",{name:"실행 중",exact:true}).click();const reason=picker.getByRole("textbox",{name:"다시 실행할 사유"});await reason.fill("보고를 보완합니다");
 state.setFailure(true);state.setDelay(true);const save=picker.getByRole("button",{name:"확인",exact:true});await save.click();await expect(save).toBeDisabled();expect(state.writes).toHaveLength(1);await expect(state.board.locator('[data-board-column="review"] [data-card-id="home-4-0"]')).toHaveCount(1);
 await expect(picker.getByRole("alert")).toContainText("fixture version conflict");await expect(reason).toHaveValue("보고를 보완합니다");state.setFailure(false);state.setDelay(false);await picker.getByRole("button",{name:"갱신 후 재시도"}).click();await expect(save).toBeEnabled();await save.click();
 await expect(state.board.locator('[data-board-column="running"] [data-card-id="home-4-0"]')).toHaveCount(1);expect(state.writes).toHaveLength(2);expect(state.writes[1].body).toMatchObject({status:"running",reason:"보고를 보완합니다",expectedVersion:reviewCard.version});writeFileSync(path.join(output,"reason-failure.json"),JSON.stringify(state.writes,null,2));
});


test.describe("touch alternative",()=>{
 test.use({hasTouch:true,viewport:{width:390,height:844}});
 test("the existing status chip exposes the same guarded transition",async({page})=>{
  const state=await fixture(page),review=state.board.locator('[data-card-id="home-4-0"]');await review.scrollIntoViewIfNeeded();await review.getByRole("button",{name:"카드 상태 변경",exact:true}).tap();
  await page.locator('[data-card-status-picker]').getByRole("button",{name:"완료",exact:true}).tap();await expect(state.board.locator('[data-board-column="done"] [data-card-id="home-4-0"]')).toHaveCount(1);expect(state.writes).toHaveLength(1);expect(state.writes[0].body).toMatchObject({status:"done",expectedVersion:reviewCard.version});await expect(page.getByTestId("card-detail")).toHaveCount(0);writeFileSync(path.join(output,"touch-menu.json"),JSON.stringify(state.writes,null,2));
 });
});
