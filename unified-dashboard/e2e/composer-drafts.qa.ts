import {expect,test,type Locator} from "@playwright/test";
import {mkdirSync,readFileSync,writeFileSync} from "node:fs";
import path from "node:path";
import {installV3VisualQaRoutes} from "./v3-visual-fixtures";
const phase=process.env.COMPOSER_DRAFT_PHASE;
const output=process.env.COMPOSER_DRAFT_EVIDENCE_DIR;
if(!output||!phase)throw new Error("COMPOSER_DRAFT_PHASE and COMPOSER_DRAFT_EVIDENCE_DIR are required");
const now="2026-10-01T00:00:00Z";
const geometry=(scope:Locator)=>scope.evaluate(el=>{
 const box=(selector:string)=>{
  const node=el.querySelector(selector)!,r=node.getBoundingClientRect(),s=getComputedStyle(node);
  return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height,
   padding:s.padding,margin:s.margin,gap:s.gap,fontSize:s.fontSize,lineHeight:s.lineHeight,borderRadius:s.borderRadius,outline:s.outlineStyle};
 };
 return {frame:box(".v3-card-handoff"),controls:box(".v3-card-handoff-controls"),composer:box('[data-testid="card-composer"]'),
  body:box('[data-slot="chat-input-body"]'),send:box('[data-testid="send-button"]'),chip:box(".v3-card-handoff-chip")};
});
for(const width of [1440,390])test(`composer drafts ${width} ${phase}`,async({page})=>{
 await page.setViewportSize({width,height:1000});await page.emulateMedia({colorScheme:"dark",reducedMotion:"reduce"});
 await page.clock.install({time:new Date(now)});
 await page.addInitScript(()=>{
  localStorage.setItem("soul-dashboard-theme","dark");localStorage.setItem("ls.webglGlass","0");
  localStorage.setItem("soul-user-preferences:qa@example.test",JSON.stringify({chatFontSize:17}));
  localStorage.setItem("cards-p1-handoff",JSON.stringify({folderId:"folder-amber",nodeId:"eiaserinnys",agentId:"roselin_codex",modelPreset:"qa-standard"}));
  Object.defineProperty(navigator.serviceWorker,"register",{configurable:true,value:async()=>({update:async()=>undefined,active:null,addEventListener:()=>undefined})});
  Object.defineProperty(navigator.serviceWorker,"controller",{configurable:true,get:()=>null});
 });
 await installV3VisualQaRoutes(page,{unifiedFolderView:true,timelineEventCount:1});
 const cards=["a","b"].map(id=>({id,folderId:"folder-amber",title:`초안 카드 ${id.toUpperCase()}`,request:"지시 본문",brief:"펼친 요약",status:"running",blockedKind:null,positionKey:id,queuePositionKey:null,assigneeKind:"session",assigneeSessionId:"run-alpha-1",nodeId:"eiaserinnys",assigneeAgentId:"roselin_codex",modelPreset:"qa-standard",version:1,archived:false,createdAt:now,updatedAt:now}));
 let mainFail=false,commentFail=false,longNames=false;
 const writes:string[]=[];
 await page.route("**/api/**",async route=>{
  const req=route.request(),url=new URL(req.url()),p=url.pathname;
  const json=(value:unknown)=>route.fulfill({contentType:"application/json",body:JSON.stringify(value)});
  if(p==="/api/auth/config")return json({authEnabled:true,devModeEnabled:false});
  if(p==="/api/auth/status")return json({authenticated:true,user:{email:"qa@example.test",name:"QA",isAdmin:true}});
  if(p==="/api/user/preferences")return json({preferences:{chatFontSize:17},hasBackground:false});
  if(p==="/api/cards")return json({cards});
  const card=cards.find(card=>p===`/api/cards/${card.id}`);
  if(card)return json({card,sessions:[],reports:[],questions:[],comments:[]});
  if(/^\/api\/cards\/[ab]\/comments$/.test(p)){
   if(commentFail)return route.fulfill({status:500,contentType:"application/json",body:JSON.stringify({error:"커멘트 실패"})});
   writes.push(req.postDataJSON().body);return json({id:`comment-${writes.length}`,cardId:p.split("/")[3],authorKind:"user",body:writes.at(-1),kind:"comment",createdAt:now});
  }
  if(p==="/api/sessions"&&req.method()==="POST"){
   if(mainFail)return route.fulfill({status:500,contentType:"application/json",body:JSON.stringify({detail:"세션 생성 실패"})});
   return json({agentSessionId:"created",nodeId:"eiaserinnys",prompt:req.postDataJSON().initial_instruction});
  }
  if(p==="/api/nodes/eiaserinnys/agents")return json({agents:[{id:"roselin_codex",name:longNames?"매우 긴 에이전트 이름을 선택해도 전송 버튼이 밀려나지 않습니다 ".repeat(3):"로젤린",backend:"codex",default_preset:"qa-standard"}]});
  return route.fallback();
 });
 mkdirSync(output,{recursive:true});
 const capture=async(name:string)=>{await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:path.join(output,`${phase}-${width}-${name}.png`),animations:"disabled"});};
 await page.goto("/v3");
 const main=page.locator(".v3-today-handoff"),input=main.getByLabel("세션 첫 메시지");
 await expect(input).toBeVisible();await input.fill("");await capture("main-empty");
 const empty=await geometry(main);
 await input.fill("첫 줄\n둘째 줄\n셋째 줄\n넷째 줄");await capture("main-multiline");const multiline=await geometry(main);
 expect(multiline.send.height).toBe(empty.send.height);expect(multiline.chip.height).toBe(empty.chip.height);
 longNames=true;await page.reload();await expect(input).toBeVisible();await input.fill("긴 선택명과 본문");
 // The picker is mounted; wait for its agent label to load.
 await expect(main.locator(".v3-card-handoff-execution")).toContainText("매우 긴 에이전트");
 await capture("main-long-selection");const long=await geometry(main);
 expect(long.send.right).toBeLessThanOrEqual(long.frame.right);
 const metrics={empty,multiline,long};
 writeFileSync(path.join(output,`${phase}-${width}-metrics.json`),JSON.stringify(metrics,null,2));
 if(phase==="after"){
  const before=JSON.parse(readFileSync(path.join(output,`before-${width}-metrics.json`),"utf8"));
  for(const state of ["empty","multiline","long"] as const)for(const part of ["frame","controls","composer","body","send","chip"] as const){
   for(const property of ["padding","margin","gap","fontSize","lineHeight","borderRadius"] as const)expect(metrics[state][part][property]).toBe(before[state][part][property]);
   for(const axis of ["left","right","width","height"] as const)expect(Math.abs(metrics[state][part][axis]-before[state][part][axis])).toBeLessThanOrEqual(1);
  }
  expect(empty.controls.bottom).toBeLessThan(empty.composer.top);
  await input.fill("새로고침할 메인 초안");await page.reload();await expect(input).toHaveValue("새로고침할 메인 초안");
  await page.goto("/components");await page.goto("/v3");await expect(input).toHaveValue("새로고침할 메인 초안");
  mainFail=true;await main.getByRole("button",{name:"세션 시작",exact:true}).click();await expect(main.locator("xpath=..").getByRole("alert")).toContainText("세션 생성 실패");await expect(input).toHaveValue("새로고침할 메인 초안");
  mainFail=false;await main.getByRole("button",{name:"세션 시작",exact:true}).click();await expect(input).toHaveValue("");
  await page.reload();await expect(input).toHaveValue("");
 }
 const open=async(id:string)=>{await page.locator(`[data-card-id="${id}"]`).getByRole("button",{name:`카드 초안 카드 ${id.toUpperCase()} 열기`,exact:true}).click();await expect(page.getByTestId("card-detail")).toBeVisible();};
 await open("a");const detail=page.getByTestId("card-detail"),comment=detail.getByPlaceholder("커멘트",{exact:true});
 await comment.fill("카드 A 초안");await capture("card-comments");
 const fixed=async()=>detail.evaluate(el=>{
  const box=(selector:string)=>{const r=el.querySelector(selector)!.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom};};
  return {sessions:box('[data-card-section="sessions"]'),dock:box(".v3-card-comment-dock")};
 });
 const comments=await fixed();await detail.getByRole("tab",{name:"내용",exact:true}).click();await expect(comment).toHaveValue("카드 A 초안");
 const content=await fixed();expect(content).toEqual(comments);await expect(detail.locator("textarea")).toHaveCount(1);await capture("card-content");
 await detail.getByRole("button",{name:"카드 닫기",exact:true}).click();
 if(phase==="before")return;
 await open("b");await expect(comment).toHaveValue("");await comment.fill("카드 B 초안");await detail.getByRole("button",{name:"카드 닫기",exact:true}).click();
 await open("a");await expect(comment).toHaveValue("카드 A 초안");await page.reload();await open("a");await expect(comment).toHaveValue("카드 A 초안");
 commentFail=true;await detail.getByRole("button",{name:"커멘트 전송",exact:true}).click();await expect(detail.getByRole("alert")).toBeVisible();await expect(comment).toHaveValue("카드 A 초안");
 commentFail=false;await detail.getByRole("button",{name:"커멘트 전송",exact:true}).click();await expect(comment).toHaveValue("");
 await detail.getByRole("button",{name:"카드 닫기",exact:true}).click();await open("b");await expect(comment).toHaveValue("카드 B 초안");
 await page.goto("/components");const sample=page.locator("#components-input");await sample.scrollIntoViewIfNeeded();
 const beforeDrafts=await page.evaluate(()=>localStorage.getItem("soul-dashboard-storage"));
 const unexpectedWrites:string[]=[];page.on("request",req=>{if(req.method()!=="GET"&&new URL(req.url()).pathname.startsWith("/api/"))unexpectedWrites.push(req.url());});
 await sample.getByLabel("검수 메시지").fill("검수 샘플 로컬 초안");await sample.getByRole("button",{name:"샘플 전송",exact:true}).click();await expect(sample.getByLabel("검수 메시지")).toHaveValue("");
 expect(await page.evaluate(()=>localStorage.getItem("soul-dashboard-storage"))).toBe(beforeDrafts);expect(unexpectedWrites).toEqual([]);
 await capture("review-shared-view");
});
