import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { installV3VisualQaRoutes } from "./v3-visual-fixtures";
import type { CardRow } from "../../packages/soul-ui/src/cards/card-types";
const output = path.resolve(process.env.TODAY_OUTPUT!);
const baseline = Boolean(process.env.TODAY_BASELINE);
const now = "2026-09-30T07:00:00.000Z";
const card = (id: string, status: CardRow["status"], title: string, extra = {}): CardRow => ({
 id, status, title, request: "요청 원문", brief: "", folderId: "folder-amber", blockedKind: null, blockedDetail: null,
 positionKey: id, queuePositionKey: id, assigneeKind: "agent", assigneeAgentId: "roselin_codex", assigneeUserId: null,
 assigneeSessionId: null, nodeId: "eiaserinnys", modelPreset: "qa-standard", version: 1, archived: false, createdAt: now, updatedAt: now, ...extra,
});
for (const viewport of [{width:1440,height:900},{width:2148,height:1222},{width:390,height:844}]) {
 for (const populated of [false, true]) {
 test(`${viewport.width} ${populated ? "cards" : "empty"}`, async ({page}) => {
  await page.setViewportSize(viewport); await page.emulateMedia({colorScheme:"dark",reducedMotion:"reduce"});
  await page.addInitScript(() => {
   localStorage.setItem("soul-dashboard-theme", "dark");localStorage.setItem("ls.webglGlass", "0");
   localStorage.setItem("cards-p1-handoff",JSON.stringify({folderId:"folder-amber",nodeId:"eiaserinnys",agentId:"roselin_codex",modelPreset:"qa-standard"}));
   Object.defineProperty(navigator.serviceWorker,"register",{configurable:true,value:async()=>({update:async()=>undefined,active:null,addEventListener:()=>undefined})});
   Object.defineProperty(navigator.serviceWorker,"controller",{configurable:true,get:()=>null});
  });
  await installV3VisualQaRoutes(page,{unifiedFolderView:true});
  const rows = populated ? [card("review","review","폴더 화면 헤더 통일"),card("question","blocked","문서 이관: 이미지 블록 12개는 어떻게 할까요?",{blockedKind:"question"}),card("running","running","체크리스트 깜빡임 수리"),card("q1","queued","보드 여닫기 앱에도"),card("q2","queued","xops 3안 선택 통계 화면")] : [];
  let created: CardRow | undefined; let payload: any;
  await page.route("**/api/**", async route => {
   const req=route.request(),url=new URL(req.url());const json=(value:unknown)=>route.fulfill({contentType:"application/json",body:JSON.stringify(value)});
   if(url.pathname==="/api/auth/config")return json({authEnabled:true,devModeEnabled:false});
   if(url.pathname==="/api/auth/status")return json({authenticated:true,user:{email:"qa@example.test",name:"QA",isAdmin:true}});
   if(url.pathname==="/api/planner/today")return json({daily:{page:{id:"daily",title:"오늘",version:1,metadata:{},archived:false},blocks:[],state_vector:""},folders:[],memoBlocks:[],reviewSessionIds:[],attention:rows.filter(c=>["review","blocked"].includes(c.status)),running:rows.filter(c=>c.status==="running"),queued:rows.filter(c=>c.status==="queued")});
   if(url.pathname==="/api/attachments/sessions") {
    expect(url.searchParams.get("nodeId")).toBe("eiaserinnys");expect(req.postDataBuffer()?.toString()).toContain('filename="참고.png"');
    return json({path:"/incoming/qa/참고.png"});
   }
   if(url.pathname==="/api/attachments/files")return route.fulfill({contentType:"image/png",body:Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=","base64")});
   if(url.pathname==="/api/cards") {
    if(req.method()==="GET")return json({cards:[...rows,...created?[created]:[]]});
    payload=req.postDataJSON();created=card("created","queued",payload.title,{request:payload.request});return json({card:created});
   }
   if(url.pathname==="/api/cards/created")return json({card:created,reports:[],questions:[],sessions:[]});
   return route.fallback();
  });
  await page.goto("/v3");const input=page.getByRole("textbox",{name:"무엇을 맡길까요"});await expect(input).toBeVisible();
  await expect(page.locator('.v3-card-inbox [data-card-id]')).toHaveCount(rows.length);
  await page.evaluate(()=>document.fonts.ready);await page.waitForTimeout(200);
  const name=`${viewport.width}-${populated?"cards":"empty"}`;mkdirSync(output,{recursive:true});
  await page.screenshot({path:path.join(output,`${name}.png`)});
  if(baseline){await expect(input).toHaveAttribute("rows","3",{timeout:1000});return;}
  const metrics=await measure(page);writeFileSync(path.join(output,`${name}.json`),JSON.stringify(metrics,null,2));

  expect(metrics.column.width).toBeLessThanOrEqual(892);
  expect(Math.abs(metrics.column.x+metrics.column.width/2-(metrics.scroll.x+metrics.scroll.width/2))).toBeLessThanOrEqual(1);
  expect(metrics.memo.x).toBeCloseTo(metrics.composer.x,0);expect(metrics.memo.right).toBeCloseTo(metrics.composer.right,0);
  expect(metrics.textarea.height).toBe(66);expect(metrics.attach.width).toBe(32);expect(metrics.attach.height).toBe(32);
  expect(metrics.folder.height).toBe(28);expect(metrics.execution.height).toBe(28);
  expect(Math.abs(metrics.attach.cy-metrics.send.cy)).toBeLessThanOrEqual(1);
  if(viewport.width>760)expect(Math.abs(metrics.folder.cy-metrics.send.cy)).toBeLessThanOrEqual(1);
  expect(metrics.rows.every(r=>r.height===56)).toBe(true);
  expect(metrics.visibleSelects).toBe(0);
  if(!populated){await expect(page.locator('[data-card-group]')).toHaveCount(0);await expect(page.getByText("지금은 확인할 것이 없습니다")).toBeVisible();}
  else {await expect(page.locator('.v3-date-head')).toContainText("확인할 것 2 / 진행 중 1 / 대기 2");await expect(page.locator('[data-card-group=queued] .v3-card-status--queued').first()).toHaveText("1번");}
  // Every visual assertion is executed against the baseline once before implementation.
  if(viewport.width===1440 && !populated) {
   await page.locator('.v3-card-handoff input[type=file]').setInputFiles({name:"참고.png",mimeType:"image/png",buffer:Buffer.from("image")});
   await expect(page.locator('.v3-card-attachments')).toContainText("참고.png");
   await input.fill("첨부를 확인해 주세요");await page.getByRole("button",{name:"맡기기",exact:true}).click();
   await expect(page.getByRole("button",{name:"카드 첨부를 확인해 주세요 열기"})).toBeVisible();
   expect(payload.request).toContain("첨부: 참고.png(");expect(payload.request).toContain("/api/attachments/files?nodeId=eiaserinnys&path=");
   await page.getByRole("button",{name:"카드 첨부를 확인해 주세요 열기"}).click();
   await expect(page.locator('[data-card-section=request] img')).toHaveAttribute("src",/attachments\/files/);
   await page.screenshot({path:path.join(output,"attachment-detail.png")});writeFileSync(path.join(output,"attachment-request.json"),JSON.stringify(payload,null,2));
  }
 });
 }
}
async function measure(page:Page){return page.evaluate(()=>{
 const rect=(s:string)=>{const r=document.querySelector(s)!.getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height,cy:r.y+r.height/2};};
 return {column:rect('.v3-planner-column--daily'),scroll:rect('[data-testid=v3-planner-scroll]'),memo:rect('.v3-daily-memo'),composer:rect('.v3-card-handoff'),textarea:rect('.v3-card-handoff textarea'),folder:rect('.v3-card-handoff-folder'),execution:rect('.v3-card-handoff-execution'),attach:rect('.v3-card-handoff-attach'),send:rect('.v3-card-handoff-submit'),rows:Array.from(document.querySelectorAll('.v3-card-inbox .v3-card-row')).map(el=>({height:el.getBoundingClientRect().height})),visibleSelects:Array.from(document.querySelectorAll('select')).filter(el=>el.getBoundingClientRect().height>0).length};
});}
