import {expect,test,type Page} from "@playwright/test";
import {mkdirSync,writeFileSync} from "node:fs";
import path from "node:path";
import {installV3VisualQaRoutes} from "./v3-visual-fixtures";
import {reviewCard,reviewDetail} from "../client/v3/components-review-fixtures";
import {DEFAULT_USER_PREFERENCES} from "../../packages/soul-ui/src/lib/user-preferences";
const output=path.resolve("../../../.local/artifacts/20261005-card-content-status-menu-scale");
mkdirSync(output,{recursive:true});
async function prepare(page:Page,width:number,fontSize:14|17|18) {
 const cards=Array.from({length:8},(_,index)=>({...reviewCard,id:`scale-${index}`,folderId:"folder-amber",
  title:index===0?"아주 긴 한국어 제목이 작은 완료 버튼과 함께 있어도 두 줄 영역을 유지하는지 확인합니다":`동일 비율 카드 ${index}`,
  status:(["review","running","blocked","queued","done","todo","cancelled","running"] as const)[index],
  blockedKind:index===2?"question" as const:null,assigneeKind:index===2?null:reviewCard.assigneeKind,
  assigneeAgentId:index===1?"매우 긴 담당 에이전트 이름으로 말줄임을 확인합니다":reviewCard.assigneeAgentId,
  latestActivity:index===1?null:{kind:index%2===0?"report" as const:"instruction" as const,format:"markdown" as const,
   body:"원문 여러 줄을 그대로 보여 줍니다. 제목과 본문, 담당과 상태가 충돌하지 않으며 설정된 채팅 글자 크기와 같은 크기로 읽습니다. ".repeat(5),createdAt:reviewCard.createdAt},
 }));
 const state={cards,reads:[] as string[],writes:[] as Record<string,unknown>[],fail:false,hold:false,release:null as (()=>void)|null};
 await page.setViewportSize({width,height:1000});await page.emulateMedia({colorScheme:width===390?"dark":"light",reducedMotion:"reduce"});
 await page.addInitScript(()=>{localStorage.setItem("ls.webglGlass","0");Object.defineProperty(navigator.serviceWorker,"register",{configurable:true,value:async()=>({update:async()=>{},active:null,addEventListener:()=>{}})});});
 await installV3VisualQaRoutes(page,{unifiedFolderView:true,postitCards:cards});
 await page.route("**/api/auth/config",route=>route.fulfill({contentType:"application/json",body:JSON.stringify({authEnabled:true,devModeEnabled:false})}));
 await page.route("**/api/auth/status",route=>route.fulfill({contentType:"application/json",body:JSON.stringify({authenticated:true,user:{email:"scale@example.test",name:"검수"}})}));
 await page.route("**/api/user/preferences",route=>route.fulfill({contentType:"application/json",body:JSON.stringify({email:"scale@example.test",preferences:{...DEFAULT_USER_PREFERENCES,chatFontSize:fontSize},hasBackground:false})}));
 await page.route("**/api/cards/**",async route=>{
  const match=new URL(route.request().url()).pathname.match(/^\/api\/cards\/([^/]+)(.*)$/),card=cards.find(card=>card.id===match?.[1]);
  if(!card)return route.fulfill({status:404,body:"{}"});
  if(route.request().method()==="GET"&&match?.[2]==="") {
   state.reads.push(card.id);if(card.version===1)card.version=7;
   return route.fulfill({contentType:"application/json",body:JSON.stringify({card,reports:card.id==="scale-1"?[]:reviewDetail.reports,
    questions:card.id==="scale-2"?[{id:"q",text:"질문",answer:null,options:null,askedAt:card.createdAt,answeredAt:null}]:[],sessions:[],comments:[]})});
  }
  const endpoint=match?.[2];
  if(route.request().method()!=="POST"||(endpoint!=="/status"&&endpoint!=="/execute"))return route.fulfill({status:405,body:"{}"});
  const body=route.request().postDataJSON();state.writes.push({...body,endpoint});
  if(state.hold)await new Promise<void>(resolve=>{state.release=resolve;});
  if(body.expectedVersion!==card.version||state.fail){state.fail=false;card.version++;return route.fulfill({status:409,body:JSON.stringify({message:"version conflict. 최신 카드 상태를 다시 확인해야 합니다. ".repeat(8)})});}
  if(endpoint==="/execute"){
   card.status="running";card.version++;
   return route.fulfill({contentType:"application/json",body:JSON.stringify({card,execution:{requestId:`request-${card.id}`,sessionId:"scale-session",state:"started"}})});
  }
  card.status=body.status;card.version++;
  return route.fulfill({contentType:"application/json",body:"{}"});
 });
 return state;
}
async function metrics(page:Page) {
 return page.locator(".v3-postit-card").evaluateAll(nodes=>nodes.map(node=>{
  const card=node as HTMLElement,body=card.querySelector<HTMLElement>(".v3-postit-body")!,footer=card.querySelector<HTMLElement>(".v3-postit-footer")!,title=card.querySelector<HTMLElement>(".v3-postit-title")!;
  const style=getComputedStyle(card),b=getComputedStyle(body),t=getComputedStyle(title);
  return {id:card.dataset.cardId,variant:card.dataset.cardSize,width:parseFloat(style.width),height:parseFloat(style.height),bodyFont:parseFloat(b.fontSize),lineHeight:parseFloat(b.lineHeight),
   lines:b.webkitLineClamp,labelPresent:Boolean(card.querySelector(".v3-postit-latest-label")),bodyBottom:body.offsetTop+body.offsetHeight,footerTop:footer.offsetTop,
   titleFont:parseFloat(t.fontSize),titleLine:parseFloat(t.lineHeight),transform:style.transform,
   actionCount:card.querySelectorAll(".dashboard-icon-cap").length,trigger:card.querySelector<HTMLElement>(".v3-postit-status-trigger")?.offsetHeight,
   rect:{left:card.offsetLeft,top:card.offsetTop},footerInsets:{left:footer.offsetLeft,right:card.clientWidth-footer.offsetLeft-footer.offsetWidth}};
 }));
}
function assertScale(item:Awaited<ReturnType<typeof metrics>>[number],fontSize:number) {
 const frame=item.variant==="compact"?0.8:1;
 expect(item.bodyFont).toBe(fontSize);expect(item.width).toBeCloseTo(320*fontSize/17*frame,1);expect(item.height).toBeCloseTo(280*fontSize/17*frame,1);
 expect(item.lineHeight).toBeCloseTo(25*fontSize/17,2);expect(item.labelPresent).toBe(false);expect(item.actionCount).toBe(0);
 expect(item.lines).toBe(item.variant==="compact"?"3":"5");
 expect(item.bodyBottom).toBeLessThanOrEqual(item.footerTop);expect(Math.abs(item.footerInsets.left-item.footerInsets.right)).toBeLessThanOrEqual(1);
 if(item.trigger)expect(item.trigger).toBeGreaterThanOrEqual(32);
}
async function capture(page:Page,name:string) {await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:path.join(output,`${name}.png`),animations:"disabled"});}
test('unanswered question card completion saves once',async({page})=>{
 const state=await prepare(page,390,14);await page.goto('/');
 const card=page.locator('.v3-postit-card[data-card-id="scale-2"]');await expect(card).toBeVisible();
 await card.getByRole('button',{name:'카드 상태 변경'}).click();
 const popup=page.locator('[data-card-status-picker][data-open]');await expect(popup).toBeVisible();
 await expect(popup).not.toContainText('질문에 답한 뒤 변경할 수 있습니다');
 await expect(popup.getByRole('button',{name:'완료',exact:true})).toBeEnabled();
 await capture(page,'question-completion-before-390');
 await popup.getByRole('button',{name:'완료',exact:true}).click();await expect(card).toHaveCount(0);
 expect(state.writes).toHaveLength(1);expect(state.writes[0]).toMatchObject({status:'done',expectedVersion:7});
 expect(state.cards.find(card=>card.id==='scale-2')!.status).toBe('done');
 await capture(page,'question-completion-after-390');
});
for(const width of [390,1440])for(const fontSize of [14,17,18] as const)test(`main folder and components ${width} font ${fontSize}`,async({page})=>{
 const state=await prepare(page,width,fontSize);await page.goto("/");const first=page.locator(".v3-postit-card").first();await expect(first).toBeVisible();
 await expect(first.locator(".v3-postit-body")).toHaveCSS("font-size",`${fontSize}px`);
 const main=await metrics(page);main.forEach(item=>assertScale(item,fontSize));expect(state.reads).toEqual([]);
 // Mutation-test the geometry checker: a body using the old 17px at 14 must fail.
 expect(()=>assertScale({...main[0],bodyFont:99},fontSize)).toThrow();
 await capture(page,`main-${width}-${fontSize}`);await page.reload();await expect(first).toBeVisible();await expect(first.locator(".v3-postit-body")).toHaveCSS("font-size",`${fontSize}px`);
 expect((await metrics(page)).map(item=>item.transform)).toEqual(main.map(item=>item.transform));
 if(width===390){await page.getByTestId("v3-mobile-tab-projects").click();await page.getByTestId("v3-mobile-project-list").getByRole("button",{name:"소울스트림",exact:true}).click();}
 else await page.getByTestId("v3-all-projects").getByRole("button",{name:"소울스트림",exact:true}).click();
 const folder=page.getByTestId("folder-card-section");await expect(folder).toBeVisible();await folder.scrollIntoViewIfNeeded();(await metrics(page)).forEach(item=>assertScale(item,fontSize));await capture(page,`folder-${width}-${fontSize}`);
 await page.goto("/components");const samples=page.locator('[data-component="PostItCardView / PostItGrid"]');await expect(samples.locator(".v3-postit-card")).toHaveCount(14);
 await expect(samples.locator(".v3-postit-body").first()).toHaveCSS("font-size",`${fontSize}px`);
 const chatFont=await page.getByTestId("card-composer").first().locator("textarea").evaluate(node=>getComputedStyle(node).fontSize);
 expect(chatFont).toBe(`${fontSize}px`);await samples.scrollIntoViewIfNeeded();await capture(page,`components-${width}-${fontSize}`);
 await samples.locator('[data-card-id="postit-sample-3"]').getByRole("button",{name:"카드 상태 변경"}).first().click();
 await page.locator('[data-card-status-picker]').getByRole("button",{name:"완료",exact:true}).click();
 await expect(samples.locator('[data-card-id="postit-sample-3"]').first()).toHaveAttribute("data-card-status","done");expect(state.writes).toEqual([]);
 const readOnly=page.getByTestId("readonly-card-list-sample");await readOnly.scrollIntoViewIfNeeded();
 await expect(readOnly.locator(".v3-postit-card")).toHaveCount(8);
 await expect(readOnly.locator(".v3-postit-card button, .v3-postit-card [data-slot='status-chip']")).toHaveCount(0);
 writeFileSync(path.join(output,`metrics-${width}-${fontSize}.json`),JSON.stringify({main,chatFont},null,2));
});
for(const width of [390,1440])test(`status pointer keyboard retry and latest version ${width}`,async({page})=>{
 const state=await prepare(page,width,14);await page.goto("/");const card=page.locator('.v3-postit-card[data-card-id="scale-0"]');await expect(card).toBeVisible();expect(state.reads).toEqual([]);
 const trigger=card.getByRole("button",{name:"카드 상태 변경"});
  if(width===1440)await trigger.click();else{await trigger.focus();await page.keyboard.press("Enter");}
  const popup=page.locator('[data-card-status-picker][data-open]');await expect(popup).toBeVisible();expect(state.reads).toEqual(["scale-0"]);await expect(page.getByTestId("card-detail")).toHaveCount(0);
  const popupRect=await popup.boundingBox(),triggerRect=await trigger.boundingBox();
  expect(popupRect).not.toBeNull();expect(popupRect!.x).toBeGreaterThanOrEqual(0);expect(popupRect!.x+popupRect!.width).toBeLessThanOrEqual(width);
  expect(popupRect!.width).toBeLessThan((await card.boundingBox())!.width);
  if(width===1440)expect(Math.abs(popupRect!.x-triggerRect!.x)).toBeLessThanOrEqual(1);
 for(const name of ["드래프트","대기","실행 중","막힘","검수 대기","완료","취소"])await expect(popup.getByRole("button",{name,exact:true})).toBeEnabled();
 await expect(popup.getByRole("textbox")).toHaveCount(0);await capture(page,`menu-${width}`);
 state.fail=true;await popup.getByRole("button",{name:"실행 중",exact:true}).click();
 const conflict=popup.getByRole("alert").first();await expect(conflict).toContainText("카드가 변경되었습니다.");
 const conflictSize=await conflict.evaluate(node=>({width:node.clientWidth,scrollWidth:node.scrollWidth,height:node.clientHeight,lineHeight:parseFloat(getComputedStyle(node).lineHeight)}));
 expect(conflictSize.scrollWidth).toBeLessThanOrEqual(conflictSize.width);
 await expect(popup.getByRole("button",{name:"실행 중",exact:true})).toBeDisabled();expect(state.writes).toHaveLength(1);expect(state.writes[0]).toMatchObject({endpoint:"/execute",expectedVersion:7});
 await popup.getByRole("button",{name:"갱신 후 재시도"}).click();expect(state.reads).toHaveLength(2);
 state.hold=true;await popup.getByRole("button",{name:"실행 중",exact:true}).click();await expect(popup.getByRole("button",{name:"실행 중",exact:true})).toBeDisabled();
 await expect.poll(()=>Boolean(state.release)).toBe(true);state.hold=false;state.release!();await expect(card).toHaveAttribute("data-card-status","running");expect(state.writes).toHaveLength(2);expect(state.writes[1]).toMatchObject({endpoint:"/execute",expectedVersion:8});
 expect(typeof state.writes[1].idempotencyKey).toBe("string");expect(state.writes[0].idempotencyKey).not.toBe(state.writes[1].idempotencyKey);
 const secondTrigger=page.locator('.v3-postit-card[data-card-id="scale-1"]').getByRole("button",{name:"카드 상태 변경"});
 await secondTrigger.click();await expect(popup.getByRole("button",{name:"검수 대기",exact:true})).toBeEnabled();
 state.fail=true;await popup.getByRole("button",{name:"검수 대기",exact:true}).click();
 const longError=popup.getByRole("alert");await expect(longError).toContainText("version conflict");
 const longErrorSize=await longError.evaluate(node=>({width:node.clientWidth,scrollWidth:node.scrollWidth,height:node.clientHeight,lineHeight:parseFloat(getComputedStyle(node).lineHeight)}));
 expect(longErrorSize.scrollWidth).toBeLessThanOrEqual(longErrorSize.width);expect(longErrorSize.height).toBeGreaterThan(longErrorSize.lineHeight);
 await page.keyboard.press("Escape");await expect(secondTrigger).toBeFocused();
 await page.locator('.v3-postit-card[data-card-id="scale-2"]').getByRole("button",{name:"카드 상태 변경"}).click();await expect(popup).not.toContainText("질문에 답한 뒤 변경할 수 있습니다");
 for(const name of ["드래프트","대기","실행 중","막힘","검수 대기","완료","취소"])await expect(popup.getByRole("button",{name,exact:true})).toBeEnabled();
 await capture(page,`question-${width}`);expect(state.writes).toHaveLength(3);await expect(page.getByTestId("card-detail")).toHaveCount(0);
 await popup.getByRole("button",{name:"완료",exact:true}).click();await expect(page.locator('.v3-postit-card[data-card-id="scale-2"]')).toHaveCount(0);expect(state.cards.find(card=>card.id==="scale-2")!.status).toBe("done");expect(state.writes).toHaveLength(4);
});

test("context menu copies the card id, keeps the chosen order, and uses the existing transition request",async({page,context})=>{
 const state=await prepare(page,1440,17);await context.grantPermissions(["clipboard-read","clipboard-write"]);await page.goto("/");
 const card=page.locator('.v3-postit-card[data-card-id="scale-0"]'),trigger=card.getByRole("button",{name:"카드 상태 변경"});
 await card.click({button:"right"});const menu=page.locator('[data-slot="menu-popup"]');await expect(menu).toBeVisible();
 await expect(menu.locator('[data-slot="menu-label"]')).toHaveText("카드 상태 변경");
 await expect(menu.locator('[data-slot="menu-separator"]')).toHaveCount(1);
 await expect(menu.locator('[data-slot="menu-item"]').allTextContents()).resolves.toEqual([
  "카드 ID 복사","드래프트","대기","실행 중","막힘","검수 대기","완료","취소",
 ]);
 await capture(page,"context-menu-1440");
 await menu.getByRole("menuitem",{name:"카드 ID 복사"}).click();
 await expect.poll(()=>page.evaluate(()=>navigator.clipboard.readText())).toBe("scale-0");
 await trigger.focus();await page.keyboard.press("Shift+F10");await expect(menu).toBeVisible();
 await page.keyboard.press("Escape");await expect(menu).toBeHidden();await expect(trigger).toBeFocused();
 await card.click({button:"right"});await menu.getByRole("menuitem",{name:"완료",exact:true}).click();
 await expect(card).toHaveCount(0);expect(state.reads).toEqual(["scale-0","scale-0"]);
 expect(state.writes).toHaveLength(1);expect(state.writes[0]).toMatchObject({status:"done",expectedVersion:7});
 expect(state.cards.find(item=>item.id==="scale-0")!.status).toBe("done");await expect(page.getByTestId("card-detail")).toHaveCount(0);
});
