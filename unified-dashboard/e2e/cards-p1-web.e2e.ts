import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { installV3VisualQaRoutes } from "./v3-visual-fixtures";
import type { CardDetail, CardRow } from "../../packages/soul-ui/src/cards/card-types";
const output=path.resolve(process.env.CARD_WEB_OUTPUT??"./e2e/test-results/cards-p1-web");
const now="2026-09-30T05:00:00.000Z";
function card(id:string,status:CardRow["status"],extra:Partial<CardRow>={}):CardRow{return {id,folderId:"folder-amber",title:id,request:"요청 원문",brief:"**해석**과 경과",status,blockedKind:null,blockedDetail:null,positionKey:id,queuePositionKey:id,assigneeKind:"agent",assigneeAgentId:"roselin_codex",assigneeUserId:null,assigneeSessionId:null,nodeId:"eiaserinnys",modelPreset:"qa-standard",version:1,archived:false,createdAt:now,updatedAt:now,...extra};}
for(const viewport of [{name:"desktop",width:1440,height:900},{name:"narrow",width:390,height:844}] as const){
 test(`card workflow and four surfaces ${viewport.name}`,async({page})=>{
  test.setTimeout(120000);await page.setViewportSize(viewport);await page.emulateMedia({colorScheme:"dark",reducedMotion:"reduce"});
  await page.addInitScript(()=>{
   localStorage.setItem("soul-dashboard-theme","dark");localStorage.setItem("ls.webglGlass","0");localStorage.setItem("cards-p1-handoff",JSON.stringify({folderId:"folder-amber",nodeId:"eiaserinnys",agentId:"roselin_codex",modelPreset:"qa-standard"}));
   Object.defineProperty(navigator.serviceWorker,"register",{configurable:true,value:async()=>({update:async()=>undefined,active:null,addEventListener:()=>undefined})});Object.defineProperty(navigator.serviceWorker,"controller",{configurable:true,get:()=>null});
   const Native=EventSource;const sources:EventSource[]=[];
   window.EventSource=class extends Native{constructor(url:string|URL,options?:EventSourceInit){super(url,options);sources.push(this);}};
   Object.assign(window,{emitCard:(cardId:string)=>sources.filter(s=>s.url.includes("/api/sessions/stream")).forEach(s=>s.dispatchEvent(new MessageEvent("card_updated",{data:JSON.stringify({type:"card_updated",cardId,folderId:"folder-amber"}),lastEventId:"card-fixture-event"}))) });
  });
  await installV3VisualQaRoutes(page,{unifiedFolderView:true});
  const rows:Record<string,CardRow>={review:card("review","review",{title:"보고 검수"}),question:card("question","blocked",{title:"방향 확인",blockedKind:"question"}),limit:card("limit","blocked",{title:"실행 한도 대기",blockedKind:"limit"}),no_report:card("no_report","blocked",{title:"보고 누락",blockedKind:"no_report"}),running:card("running","running",{title:"자료 조사 중"}),queued:card("queued","queued",{title:"기존 대기 카드",queuePositionKey:"b"})};
  const details:Record<string,CardDetail>={};
  if(process.env.CARD_WEB_SUPPLEMENT){details.review={card:rows.review,reports:[{id:"report-new",title:"작업 결과",format:"html",body:"<style>html{color-scheme:dark}body{color:CanvasText;background:Canvas;font-family:system-ui}</style><h1>검증 완료</h1><p>핵심 흐름을 확인했습니다.</p>",createdAt:now,sessionId:null}],questions:[{id:"qid",text:"환경 확인",answer:"개발",options:null,askedAt:now,answeredAt:now}],sessions:[]};}const calls:Array<{path:string;body:Record<string,unknown>}>=[];let settingVersion=1;let limits={default:2,eiaserinnys:1};let conflict=true;let todayReads=0;
  const detail=(id:string)=>details[id]??{card:rows[id],reports:[],questions:[],sessions:[]};
  await page.route("**/api/**",async route=>{
   const request=route.request(),url=new URL(request.url()),pathname=url.pathname,body=request.method()==="GET"?{}:request.postDataJSON()??{};
   const json=(value:unknown,status=200)=>route.fulfill({status,contentType:"application/json",body:JSON.stringify(value)});
   if(pathname==="/api/auth/config")return json({authEnabled:true,devModeEnabled:false});
   if(pathname==="/api/auth/status")return json({authenticated:true,user:{email:"qa@example.test",name:"QA",isAdmin:true}});
   if(pathname==="/api/planner/today"){todayReads++;return json({daily:{page:{id:"daily",title:"오늘",version:1,metadata:{},archived:false},blocks:[],state_vector:""},folders:[],memoBlocks:[],reviewSessionIds:[],attention:Object.values(rows).filter(c=>["blocked","review"].includes(c.status)),running:Object.values(rows).filter(c=>c.status==="running"),queued:Object.values(rows).filter(c=>c.status==="queued")});}
   if(pathname==="/api/settings/card-dispatch"){
    if(request.method()==="PUT"){calls.push({path:pathname,body});if(conflict){conflict=false;settingVersion++;limits={default:3,eiaserinnys:1};return json({detail:{error:{message:"conflict"}}},409);}expect(body.expectedVersion).toBe(settingVersion);limits=body.nodeConcurrency;settingVersion++;}
    return json({settings:{version:settingVersion,nodeConcurrency:limits}});
   }
   if(pathname==="/api/cards"){
    if(request.method()==="GET")return json({cards:Object.values(rows).filter(c=>!url.searchParams.has("folderId")||c.folderId===url.searchParams.get("folderId"))});
    calls.push({path:pathname,body});const created=card("created",body.queue?"queued":"todo",{title:body.title,request:body.request,folderId:body.folderId,assigneeAgentId:body.assignee?.agentId??null,nodeId:body.nodeId??null,modelPreset:body.modelPreset??null,queuePositionKey:"c"});rows.created=created;return json({card:created},201);
   }
   const match=/^\/api\/cards\/([^/]+)(.*)$/.exec(pathname);
   if(match){const id=match[1],suffix=match[2];if(request.method()==="GET")return json(detail(id));calls.push({path:pathname,body});const c=rows[id];
    if(suffix==="/status"){c.status=body.status;c.version++;}
    if(suffix==="/queue-position"){expect(body.expectedVersion).toBe(c.version);c.queuePositionKey=body.afterCardId===null?"a":"z";c.version++;}
    if(suffix==="/questions"){details[id]={...detail(id),card:c,questions:[{id:"qid",text:"어느 환경인가요?",options:["개발","운영"],answer:null,askedAt:now,answeredAt:null}]};c.status="blocked";c.blockedKind="question";}
    if(suffix==="/questions/qid/answer"){details[id].questions[0].answer=body.answer;details[id].questions[0].answeredAt=now;c.status="running";c.blockedKind=null;c.version++;}
    if(suffix==="/reports"){details[id]={...detail(id),card:c,reports:[{id:"report-new",title:"작업 결과",body:"<style>html{color-scheme:dark}body{color:CanvasText;background:Canvas;font-family:system-ui}</style><h1>검증 완료</h1><p>핵심 흐름을 확인했습니다.</p>",format:"html",createdAt:now,sessionId:null},{id:"report-old",title:"이전 보고",body:"이전 경과",format:"markdown",createdAt:now,sessionId:null}]};c.status="review";c.version++;}
    return json({card:c});
   }
   return route.fallback();
  });
  await page.goto("/v3");const inbox=page.locator('.v3-card-inbox');await expect(inbox.locator('[data-card-group="attention"] [data-card-id]')).toHaveCount(4);

  if(process.env.CARD_WEB_SUPPLEMENT){
   await capture(page,viewport.name,"today");
   await inbox.getByRole("button",{name:"카드 보고 검수 열기"}).click();const pane=page.getByTestId("card-detail");await expect(pane).toBeVisible();
   if(viewport.name==="desktop"){
    await pane.getByRole("button",{name:"질문 섹션으로 이동"}).click();const questionScroll=await page.getByTestId("v3-planner-scroll").evaluate(el=>el.scrollTop);expect(questionScroll).toBeGreaterThan(0);
    await pane.getByRole("button",{name:"원문 섹션으로 이동"}).click();await expect.poll(()=>page.getByTestId("v3-planner-scroll").evaluate(el=>el.scrollTop)).toBeLessThan(questionScroll);
   }
   await capture(page,viewport.name,"detail");
   await expect(pane.frameLocator("iframe").getByRole("heading",{name:"검증 완료"})).toBeVisible();await pane.locator("iframe").scrollIntoViewIfNeeded();await capture(page,viewport.name,"detail-report");
   await page.keyboard.press("Escape");await expect(pane).toHaveCount(0);
   await inbox.getByRole("button",{name:"카드 보고 검수 열기"}).click();
   if(viewport.name==="narrow"){await page.getByTestId("v3-mobile-tab-projects").click();await expect(pane).toHaveCount(0);await page.getByTestId("v3-mobile-project-list").getByRole("button",{name:"소울스트림",exact:true}).click();}else{await page.getByTestId("v3-all-projects").getByRole("button",{name:"소울스트림",exact:true}).click();await expect(pane).toHaveCount(0);}
   await page.getByTestId("folder-card-section").scrollIntoViewIfNeeded();await capture(page,viewport.name,"folder");
   await page.getByTestId("config-button").click();await page.getByRole("tab",{name:"카드 실행",exact:true}).click();const dialog=page.getByRole("dialog");
   await expect(dialog.getByRole("spinbutton",{name:"기본값 동시 실행 상한"})).toHaveValue("2");await capture(page,viewport.name,"settings");
   await dialog.getByRole("spinbutton",{name:"기본값 동시 실행 상한"}).fill("4");await dialog.locator("form").getByRole("button",{name:"저장",exact:true}).click();await expect(dialog.getByRole("alert")).toContainText("최신 값");await expect(dialog.getByRole("spinbutton",{name:"기본값 동시 실행 상한"})).toHaveValue("3");await dialog.locator("form").getByRole("button",{name:"저장",exact:true}).click();await expect(dialog.getByRole("status")).toContainText("저장했습니다");
   writeFileSync(path.join(output,viewport.name,"supplement-requests.json"),JSON.stringify({calls,todayReads},null,2));return;
  }
  await capture(page,viewport.name,"today");const initialReads=todayReads;
  await page.getByRole("textbox",{name:"무엇을 맡길까요"}).fill("공유 코드 확인");await page.locator('.v3-card-handoff').getByRole("button",{name:"맡기기",exact:true}).click();
  await expect(inbox.locator('[data-card-group="queued"] [data-card-id="created"]')).toBeVisible();expect(calls.find(c=>c.path==="/api/cards")?.body).toMatchObject({folderId:"folder-amber",title:"공유 코드 확인",request:"공유 코드 확인",assignee:{kind:"agent",agentId:"roselin_codex"},nodeId:"eiaserinnys",modelPreset:"qa-standard",queue:true,idempotencyKey:expect.any(String)});
  const handle=inbox.getByRole("button",{name:"공유 코드 확인 순서 변경"});await handle.scrollIntoViewIfNeeded();await handle.focus();await page.keyboard.press("Space");await expect(handle).toHaveAttribute("aria-pressed","true");await page.keyboard.press("ArrowUp");await expect(inbox.getByRole("status")).toContainText("queued");await page.keyboard.press("Space");await expect.poll(()=>calls.some(c=>c.path.endsWith("/queue-position")&&c.body.afterCardId===null)).toBe(true);
  await inbox.getByRole("button",{name:"카드 공유 코드 확인 열기"}).click();const pane=page.getByTestId("card-detail");await expect(pane).toBeVisible();await expect(pane.getByText("공유 코드 확인",{exact:true})).toHaveCount(2);
  await page.evaluate(async()=>{await fetch("/api/cards/created/questions",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({text:"어느 환경인가요?",options:["개발","운영"],idempotencyKey:"fixture-question"})});(window as any).emitCard("created");});
  await pane.getByRole("button",{name:"개발",exact:true}).click();await pane.getByRole("button",{name:"확인",exact:true}).click();await expect(pane.getByText("답: 개발")).toBeVisible();
  await page.evaluate(async()=>{await fetch("/api/cards/created/reports",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({title:"작업 결과",format:"html",body:"<h1>검증 완료</h1>",idempotencyKey:"fixture-report"})});(window as any).emitCard("created");});
  await expect(pane.locator('[data-report-id="report-new"]')).toHaveAttribute("open","");await expect(pane.locator('[data-report-id="report-old"]')).not.toHaveAttribute("open","");await expect(pane.locator("iframe")).toHaveAttribute("sandbox","allow-scripts");await capture(page,viewport.name,"detail");
  await pane.getByRole("button",{name:"완료",exact:true}).click();await expect(pane.locator('.v3-card-status--done')).toBeVisible();expect(todayReads).toBe(initialReads);await pane.getByRole("button",{name:"카드 닫기"}).click();
  if(viewport.name==="narrow"){await page.getByTestId("v3-mobile-tab-projects").click();await page.getByTestId("v3-mobile-project-list").getByRole("button",{name:"소울스트림",exact:true}).click();}else{await page.getByTestId("v3-all-projects").getByRole("button",{name:"소울스트림",exact:true}).click();}await page.getByTestId("folder-card-section").scrollIntoViewIfNeeded();await expect(page.getByTestId("folder-card-section").getByRole("button",{name:"카드 공유 코드 확인 열기"})).toBeVisible();await capture(page,viewport.name,"folder");
  await page.getByTestId("config-button").click();await page.getByRole("tab",{name:"카드 실행",exact:true}).click();const dialog=page.getByRole("dialog");await expect(dialog.getByRole("spinbutton",{name:"기본값 동시 실행 상한"})).toHaveValue("2");await capture(page,viewport.name,"settings");
  await dialog.getByRole("spinbutton",{name:"기본값 동시 실행 상한"}).fill("4");await dialog.locator("form").getByRole("button",{name:"저장",exact:true}).click();await expect(dialog.getByRole("alert")).toContainText("최신 값");await expect(dialog.getByRole("spinbutton",{name:"기본값 동시 실행 상한"})).toHaveValue("3");await dialog.locator("form").getByRole("button",{name:"저장",exact:true}).click();await expect(dialog.getByRole("status")).toContainText("저장했습니다");
  writeFileSync(path.join(output,viewport.name,"requests.json"),JSON.stringify({calls,todayReads},null,2));
 });
}
async function capture(page:Page,name:string,surface:string){const dir=path.join(output,name);mkdirSync(dir,{recursive:true});await page.screenshot({path:path.join(dir,`${surface}.png`)});const metrics=await page.evaluate(()=>Array.from(document.querySelectorAll('.v3-date-head,.v3-section-head,.v3-card-row,.v3-run-row,.v3-folder-header,.v3-detail-section-head,.v3-card-handoff,.v3-daily-memo')).map(el=>{const rect=el.getBoundingClientRect(),style=getComputedStyle(el);return {class:el.className,x:rect.x,y:rect.y,width:rect.width,height:rect.height,font:style.font,gap:style.gap};}));writeFileSync(path.join(dir,`${surface}-metrics.json`),JSON.stringify(metrics,null,2));}
