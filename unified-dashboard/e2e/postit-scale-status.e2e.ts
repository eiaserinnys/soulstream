import {expect,test,type Page} from "@playwright/test";
import {mkdirSync,writeFileSync} from "node:fs";
import path from "node:path";
import {installV3VisualQaRoutes} from "./v3-visual-fixtures";
import {reviewCard,reviewDetail} from "../client/v3/components-review-fixtures";
import {DEFAULT_USER_PREFERENCES} from "../../packages/soul-ui/src/lib/user-preferences";
const output=path.resolve("../../../.local/artifacts/20261002-card-question-status");
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
  if(route.request().method()!=="POST"||match?.[2]!=="/status")return route.fulfill({status:405,body:"{}"});
  const body=route.request().postDataJSON();state.writes.push(body);
  if(state.hold)await new Promise<void>(resolve=>{state.release=resolve;});
  if(body.expectedVersion!==card.version||state.fail){state.fail=false;card.version++;return route.fulfill({status:409,body:JSON.stringify({message:"version conflict"})});}
  if(body.status==="review"&&card.id==="scale-1"||card.status==="review"&&body.status==="running"&&!body.reason?.trim())return route.fulfill({status:422,body:JSON.stringify({message:"invalid transition"})});
  card.status=body.status;card.version++;
  return route.fulfill({contentType:"application/json",body:"{}"});
 });
 return state;
}
async function metrics(page:Page) {
 return page.locator(".v3-postit-card").evaluateAll(nodes=>nodes.map(node=>{
  const card=node as HTMLElement,body=card.querySelector<HTMLElement>(".v3-postit-body")!,footer=card.querySelector<HTMLElement>(".v3-postit-footer")!,label=card.querySelector<HTMLElement>(".v3-postit-latest-label")!;
  const style=getComputedStyle(card),b=getComputedStyle(body),l=getComputedStyle(label);
  return {id:card.dataset.cardId,width:parseFloat(style.width),height:parseFloat(style.height),bodyFont:parseFloat(b.fontSize),lineHeight:parseFloat(b.lineHeight),
   labelFont:parseFloat(l.fontSize),labelLine:parseFloat(l.lineHeight),bodyBottom:body.offsetTop+body.offsetHeight,footerTop:footer.offsetTop,
   titleGap:parseFloat(style.getPropertyValue("--postit-scale")),transform:style.transform,
   action:card.querySelector<HTMLElement>(".dashboard-icon-cap")?.offsetWidth??null,trigger:card.querySelector<HTMLElement>(".v3-postit-status-trigger")?.offsetHeight,
   rect:{left:card.offsetLeft,top:card.offsetTop},footerInsets:{left:footer.offsetLeft,right:card.clientWidth-footer.offsetLeft-footer.offsetWidth}};
 }));
}
function assertScale(item:Awaited<ReturnType<typeof metrics>>[number],fontSize:number) {
 expect(item.bodyFont).toBe(fontSize);expect(item.width).toBeCloseTo(320*fontSize/17,1);expect(item.height).toBeCloseTo(280*fontSize/17,1);
 expect(item.lineHeight).toBeCloseTo(25*fontSize/17,2);expect(item.labelFont).toBeGreaterThanOrEqual(13);expect(item.labelLine).toBeGreaterThanOrEqual(20);
 expect(item.bodyBottom).toBeLessThanOrEqual(item.footerTop);expect(Math.abs(item.footerInsets.left-item.footerInsets.right)).toBeLessThanOrEqual(1);
 if(item.action)expect(item.action).toBeGreaterThanOrEqual(32);if(item.trigger)expect(item.trigger).toBeGreaterThanOrEqual(32);
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
 await page.goto("/components");const samples=page.locator('[data-component="PostItCardView / PostItGrid"]');await expect(samples.locator(".v3-postit-card")).toHaveCount(7);
 await expect(samples.locator(".v3-postit-body").first()).toHaveCSS("font-size",`${fontSize}px`);
 const chatFont=await page.getByTestId("card-composer").first().locator("textarea").evaluate(node=>getComputedStyle(node).fontSize);
 expect(chatFont).toBe(`${fontSize}px`);await samples.scrollIntoViewIfNeeded();await capture(page,`components-${width}-${fontSize}`);
 await samples.locator('[data-card-id="postit-sample-4"]').getByRole("button",{name:"카드 상태 변경"}).click();
 await page.locator('[data-card-status-picker]').getByRole("button",{name:"완료",exact:true}).click();
 await expect(samples.locator('[data-card-id="postit-sample-4"]')).toHaveAttribute("data-card-status","done");expect(state.writes).toEqual([]);
 writeFileSync(path.join(output,`metrics-${width}-${fontSize}.json`),JSON.stringify({main,chatFont},null,2));
});
for(const width of [390,1440])test(`status pointer keyboard retry and latest version ${width}`,async({page})=>{
 const state=await prepare(page,width,14);await page.goto("/");const card=page.locator('.v3-postit-card[data-card-id="scale-0"]');await expect(card).toBeVisible();expect(state.reads).toEqual([]);
 const trigger=card.getByRole("button",{name:"카드 상태 변경"});await trigger.focus();await page.keyboard.press("Enter");
 const popup=page.locator('[data-card-status-picker][data-open]');await expect(popup).toBeVisible();expect(state.reads).toEqual(["scale-0"]);await expect(page.getByTestId("card-detail")).toHaveCount(0);
 await popup.getByRole("button",{name:"실행 중",exact:true}).click();const input=popup.getByRole("textbox",{name:"다시 실행할 사유"});await expect(input).toBeVisible();await expect(popup.getByRole("button",{name:"확인"})).toBeDisabled();
 await input.fill("수정 요청");await capture(page,`reason-${width}`);await popup.getByRole("button",{name:"취소",exact:true}).click();expect(state.writes).toEqual([]);
 await popup.getByRole("button",{name:"실행 중",exact:true}).click();await input.fill("사용자 수정 요청");state.fail=true;
 await popup.getByRole("button",{name:"확인",exact:true}).click();await expect(popup.getByRole("alert")).toContainText("version conflict");await expect(input).toHaveValue("사용자 수정 요청");
 await expect(popup.getByRole("button",{name:"확인",exact:true})).toBeDisabled();expect(state.writes).toHaveLength(1);expect(state.writes[0]).toMatchObject({status:"running",reason:"사용자 수정 요청",expectedVersion:7});
 await capture(page,`error-${width}`);await popup.getByRole("button",{name:"갱신 후 재시도"}).click();await expect(popup.getByRole("button",{name:"확인",exact:true})).toBeEnabled();expect(state.reads).toHaveLength(2);
 state.hold=true;await popup.getByRole("button",{name:"확인",exact:true}).click();await expect(popup.getByRole("button",{name:"확인",exact:true})).toBeDisabled();await expect(card.getByRole("button",{name:"완료",exact:true})).toBeDisabled();
 await expect.poll(()=>Boolean(state.release)).toBe(true);state.hold=false;state.release!();await expect(card).toHaveAttribute("data-card-status","running");expect(state.writes).toHaveLength(2);expect(state.writes[1]).toMatchObject({status:"running",expectedVersion:8});
 expect(typeof state.writes[1].idempotencyKey).toBe("string");expect(state.writes[0].idempotencyKey).not.toBe(state.writes[1].idempotencyKey);await expect(page.getByTestId("card-detail")).toHaveCount(0);
 await page.locator('.v3-postit-card[data-card-id="scale-1"]').getByRole("button",{name:"카드 상태 변경"}).click();await expect(popup.getByRole("button",{name:"검수 대기",exact:true})).toBeDisabled();await expect(popup.getByRole("button",{name:"검수 대기",exact:true})).toHaveAttribute("title","보고가 필요합니다");await page.keyboard.press("Escape");
 await page.locator('.v3-postit-card[data-card-id="scale-2"]').getByRole("button",{name:"카드 상태 변경"}).click();await expect(popup).not.toContainText("질문에 답한 뒤 변경할 수 있습니다");
 for(const name of ["드래프트","대기","실행 중","검수 대기","완료","취소"])await expect(popup.getByRole("button",{name,exact:true})).toBeEnabled();
 await capture(page,`question-${width}`);expect(state.writes).toHaveLength(2);await expect(page.getByTestId("card-detail")).toHaveCount(0);
 await popup.getByRole("button",{name:"완료",exact:true}).click();await expect(page.locator('.v3-postit-card[data-card-id="scale-2"]')).toHaveCount(0);expect(state.cards.find(card=>card.id==="scale-2")!.status).toBe("done");expect(state.writes).toHaveLength(3);
});
