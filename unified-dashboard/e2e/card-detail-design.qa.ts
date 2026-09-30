import { expect,test } from "@playwright/test";
import { mkdirSync,readFileSync,writeFileSync } from "node:fs";
import path from "node:path";
import { installV3VisualQaRoutes } from "./v3-visual-fixtures";
const output=path.resolve(process.env.CARD_DETAIL_OUTPUT!);
const phase=process.env.CARD_DETAIL_PHASE==="before"?"before":"after";
const fixture=JSON.parse(readFileSync(process.env.CARD_DETAIL_FIXTURE!,"utf8"));
test.use({timezoneId:"Asia/Seoul"});
for(const width of [1440,390]){
 test(`card and folder · ${width} · ${phase}`,async({page})=>{
  await page.setViewportSize({width,height:1000});await page.emulateMedia({colorScheme:"dark",reducedMotion:"reduce"});
  await page.addInitScript(()=>{
   localStorage.setItem("soul-dashboard-theme","dark");localStorage.setItem("ls.webglGlass","0");
   Object.defineProperty(navigator.serviceWorker,"register",{configurable:true,value:async()=>({update:async()=>undefined,active:null,addEventListener:()=>undefined})});
   Object.defineProperty(navigator.serviceWorker,"controller",{configurable:true,get:()=>null});
  });
  await installV3VisualQaRoutes(page,{unifiedFolderView:true});
  const card={...fixture.card,folderId:"folder-amber",status:"running"};
  const root=fixture.sessions[0].sessionId;
  const sessions=fixture.sessions.map((s:any,i:number)=>({...s,agentSessionId:s.sessionId,callerSessionId:i?root:null,eventCount:1,updatedAt:s.updatedAt??s.createdAt,folderId:"folder-amber"}));
  let reject=false;const writes:any[]=[];
  await page.route("**/api/**",async route=>{
   const req=route.request(),url=new URL(req.url()),p=url.pathname;
   const json=(v:unknown,status=200)=>route.fulfill({status,contentType:"application/json",body:JSON.stringify(v)});
   if(p==="/api/auth/config")return json({authEnabled:true,devModeEnabled:false});
   if(p==="/api/auth/status")return json({authenticated:true,user:{email:"qa@example.test",name:"QA",isAdmin:true}});
   if(p==="/api/planner/today")return json({daily:{page:{id:"daily",title:"오늘",version:1,metadata:{},archived:false},blocks:[],state_vector:""},folders:[],memoBlocks:[],reviewSessionIds:[],attention:[],running:[card],queued:[]});
   if(p==="/api/cards")return json({cards:[card]});
   if(p===`/api/cards/${card.id}`)return json({card,reports:[],questions:[],sessions:fixture.sessions});
   if(p===`/api/cards/${card.id}/status`){
    const payload=req.postDataJSON();writes.push(payload);
    if(reject)return json({detail:{error:{message:"검수에는 보고가 필요합니다"}}},422);
    card.status=payload.status;card.version++;return json({card});
   }
   if(p==="/api/sessions"&&url.searchParams.has("session_id"))return json({sessions:sessions.filter((s:any)=>url.searchParams.getAll("session_id").includes(s.agentSessionId)),total:sessions.length});
   if(p==="/api/planner/folders/folder-amber/sessions")return json({items:sessions,nextCursor:null});
   if(p==="/api/planner/folders/folder-amber"){
    return json({cards:[],folder:{id:"folder-amber",name:"소울스트림",projectPageId:"project-amber",parentFolderId:null,sortOrder:0,settings:{},checklistEnabled:true,status:"open",version:1,archived:false},page:{id:"project-amber",title:"소울스트림",version:1,metadata:{},archived:false},blocks:[],subfolders:{items:[],nextCursor:null},sessions:{items:sessions,nextCursor:null}});
   }
   return route.fallback();
  });
  mkdirSync(output,{recursive:true});
  await page.goto("/v3");await expect(page.locator('[data-card-id]')).toHaveCount(1);
  await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:path.join(output,`${phase}-${width}-inbox.png`)});
  const inboxMetrics=await page.locator('[data-card-id]').evaluate(el=>{
   const row=el.getBoundingClientRect(),chip=el.querySelector(".v3-status-chip")!.getBoundingClientRect(),title=el.querySelector("strong")!.getBoundingClientRect();
   return {row:{x:row.x,y:row.y,width:row.width,height:row.height},chip:{x:chip.x,y:chip.y,width:chip.width,height:chip.height},title:{x:title.x,y:title.y,width:title.width,height:title.height}};
  });
  await page.getByRole("button",{name:`카드 ${card.title} 열기`,exact:true}).click();
  const detail=page.getByTestId("card-detail");await expect(detail).toBeVisible();await expect(detail.locator('[data-card-section=sessions] .v3-run-row')).toHaveCount(34);
  await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:path.join(output,`${phase}-${width}-detail.png`)});
  await detail.locator('[data-card-section=brief]').evaluate(el=>el.scrollIntoView({block:"start"}));
  if(phase==='after')await expect(detail.locator('.v3-description-content')).toContainText('작업');
  await page.screenshot({path:path.join(output,`${phase}-${width}-brief.png`)});
  await detail.locator('[data-card-section=sessions]').evaluate(el=>el.scrollIntoView({block:"start"}));
  await page.screenshot({path:path.join(output,`${phase}-${width}-card-sessions.png`)});
  const cardMetrics=await detail.evaluate(el=>{
   const heads=[...el.querySelectorAll(".v3-detail-section-head")].map(head=>{const r=head.getBoundingClientRect();return {x:r.x,right:r.right,y:r.y};});
   const rows=[...el.querySelectorAll(".v3-run-row")].slice(0,3).map(row=>{const r=row.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};});
   return {heads,rows};
  });
  if(phase==="after"){
   await expect(detail.locator(".v3-run-children")).toHaveCount(33);
   await expect(detail.locator('[data-card-section=sessions] .v3-detail-section-head')).toContainText("34회");
   await expect(detail.getByText("아직 보고가 없습니다.",{exact:true})).toHaveCount(1);
   const chip=detail.getByRole("button",{name:"카드 상태 변경"});
   const item=(label:string)=>width<760?page.getByTestId("v3-context-menu-mobile").getByRole("button",{name:label,exact:true}):page.getByRole("menuitem",{name:label,exact:true});
   for(const [label,status] of [["할 일","todo"],["실행 중","running"],["완료","done"],["취소","cancelled"]]){
    await chip.scrollIntoViewIfNeeded();await chip.click();await item(label).click();await expect(chip).toHaveClass(new RegExp(`v3-card-status--${status}`));
   }
   reject=true;await chip.click();await item("할 일").click();await expect(detail.locator(".v3-card-error").first()).toContainText("검수에는 보고가 필요합니다");
   writes.forEach(w=>expect(w).toHaveProperty("expectedVersion"));
   await page.screenshot({path:path.join(output,`after-${width}-status-error.png`)});
  }
  await page.getByRole("button",{name:"카드 닫기"}).click();
  if(width<760){await page.getByTestId("v3-mobile-tab-projects").click();await page.getByTestId("v3-mobile-project-list").getByRole("button",{name:"소울스트림",exact:true}).click();}
  else await page.getByTestId("v3-all-projects").getByRole("button",{name:"소울스트림",exact:true}).click();
  const folderSection=page.locator('[data-task-section="sessions"]');await expect(folderSection.locator(".v3-run-row")).toHaveCount(34);
  await folderSection.evaluate(el=>el.scrollIntoView({block:"start"}));await page.evaluate(()=>document.fonts.ready);
  await page.screenshot({path:path.join(output,`${phase}-${width}-folder-sessions.png`)});
  const folderMetrics=await folderSection.evaluate(el=>({children:el.querySelectorAll(".v3-run-children").length,rows:[...el.querySelectorAll(".v3-run-row")].slice(0,3).map(row=>{const r=row.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};})}));
  writeFileSync(path.join(output,`${phase}-${width}-metrics.json`),JSON.stringify({inboxMetrics,cardMetrics,folderMetrics,writes},null,2));
 });
}
