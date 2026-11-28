import {test,expect,type Page} from "@playwright/test";
import {mkdirSync,writeFileSync} from "node:fs";
import path from "node:path";
import {installV3VisualQaRoutes} from "./v3-visual-fixtures";
import {reviewCard,reviewTitle} from "../client/v3/components-review-fixtures";
import {DEFAULT_USER_PREFERENCES} from "../../packages/soul-ui/src/lib/user-preferences";
const output=path.resolve("../../../.local/artifacts/20261002-card-home-web");
const emptyLanesOutput=path.resolve("../../../.local/artifacts/20261005-card-empty-lanes");
const emptyLanesPhase=process.env.CARD_EMPTY_PHASE??"after";
const seed=()=>["todo","queued","running","blocked","review","done"].flatMap((status,index)=>Array.from({length:index===0?4:1},(_,copy)=>({...reviewCard,id:`home-${index}-${copy}`,folderId:"folder-amber",status:status as typeof reviewCard.status,
 title:status==="todo"?reviewTitle:`${status} 카드`,latestActivity:{kind:status==="todo"?"instruction" as const:"report" as const,format:"markdown" as const,body:"긴 한국어 원문과 제목이 있어도 열과 카드 폭을 유지합니다. 마지막 지시와 보고는 카드 상세에서 이어 봅니다. ".repeat(6),createdAt:reviewCard.createdAt}})));
async function fixture(page:Page,fontSize=17,initialCards=seed(),completedExtra=0,completedOptions:{delay?:number;fail?:boolean;paginate?:boolean;detail?:string;folderFailure?:boolean;folderPending?:boolean;webglGlass?:boolean}={}){
 const cards=initialCards,reads:string[]=[],completedReads:string[]=[],creates:Record<string,unknown>[]=[],writes:{id:string;endpoint:string;body:Record<string,unknown>}[]=[];
 let failure=false,delay=false,completedFailure=completedOptions.fail??false;
 let folderFailure=completedOptions.folderFailure??false;
 let releaseFolder=()=>{};
 const folderGate=new Promise<void>(resolve=>{releaseFolder=resolve;});
 const completedAt=new Date().toISOString();
 await page.addInitScript((webglGlass)=>{localStorage.setItem("ls.webglGlass",webglGlass?"1":"0");Object.defineProperty(navigator.serviceWorker,"register",{configurable:true,value:async()=>({update:async()=>{},active:null,addEventListener:()=>{}})});
  const Native=EventSource,sources:EventSource[]=[];let sequence=0;
  window.EventSource=class extends Native{constructor(url:string|URL,options?:EventSourceInit){super(url,options);sources.push(this);}};
  Object.assign(window,{emitCard:(cardId:string)=>sources.filter(source=>source.url.includes("/api/sessions/stream")).forEach(source=>source.dispatchEvent(new MessageEvent("card_updated",{data:JSON.stringify({type:"card_updated",cardId,folderId:"folder-amber"}),lastEventId:`card-home-${++sequence}`})))});
 },completedOptions.webglGlass??false);
 await installV3VisualQaRoutes(page,{unifiedFolderView:true,postitCards:cards});
 await page.route("**/api/auth/config",route=>route.fulfill({json:{authEnabled:true,devModeEnabled:false}}));
 await page.route("**/api/auth/status",route=>route.fulfill({json:{authenticated:true,user:{email:"home@example.test",name:"검수"}}}));
 await page.route("**/api/user/preferences",route=>route.fulfill({json:{email:"home@example.test",preferences:{...DEFAULT_USER_PREFERENCES,chatFontSize:fontSize},hasBackground:false}}));
 await page.route(url=>new URL(url).pathname==="/api/cards",async route=>{
  if(route.request().method()==="GET"){
   const url=new URL(route.request().url()),folderId=url.searchParams.get("folderId"),status=url.searchParams.get("status"),query=(url.searchParams.get("q")??"").toLocaleLowerCase();
   if(status==="done"){
    completedReads.push(url.search);
    if(completedOptions.delay)await new Promise(done=>setTimeout(done,completedOptions.delay));
    if(completedFailure)return route.fulfill({status:500,json:{message:completedOptions.detail??"완료 카드 조회 실패 fixture"}});
   }
   if(status!=="done"&&folderId&&completedOptions.folderPending)await folderGate;
   if(status!=="done"&&folderId&&folderFailure)return route.fulfill({status:500,json:{message:"폴더 카드 조회 실패 fixture"}});
   const completedSeeds=Array.from({length:completedExtra},(_,index)=>({...reviewCard,id:`completed-grid-${index}`,folderId:"folder-amber",status:"done" as const,title:`완료 탐색 카드 ${index+1}`,completedAt}));
   const listed=[...cards,...completedSeeds].filter(card=>!folderId||card.folderId===folderId).filter(card=>status==="done"?card.status==="done":card.status!=="done")
    .filter(card=>!query||`${card.title} ${card.request}`.toLocaleLowerCase().includes(query));
   if(status==="done"&&completedOptions.paginate){
    const offset=Number(url.searchParams.get("cursor")??0),limit=Number(url.searchParams.get("limit")??60);
    return route.fulfill({json:{cards:listed.slice(offset,offset+limit),nextCursor:offset+limit<listed.length?String(offset+limit):null}});
   }
   return route.fulfill({json:{cards:listed,nextCursor:null}});
  }
  const body=route.request().postDataJSON();creates.push(body);
  if(failure)return route.fulfill({status:409,json:{message:"fixture create conflict"}});
  const card={...reviewCard,id:"created",folderId:body.folderId,title:body.title,request:body.request,status:"todo" as const};cards.push(card);return route.fulfill({status:201,json:{card}});
 });
 await page.route("**/api/cards/**",async route=>{
  const request=route.request(),parts=new URL(request.url()).pathname.split("/"),card=cards.find(card=>card.id===parts[3]);
  if(!card)return route.fulfill({status:404,json:{message:"fixture 카드 없음"}});
  if(request.method()==="POST"){
   const body=request.postDataJSON();writes.push({id:card.id,endpoint:`/${parts[4]}`,body});
   if(delay)await new Promise(done=>setTimeout(done,600));
   if(failure)return route.fulfill({status:409,json:{message:"fixture version conflict"}});
   if(body.expectedVersion!==card.version)return route.fulfill({status:409,json:{message:"expectedVersion 불일치"}});
   card.status=parts[4]==="execute"?"running":body.status;card.version++;
   if(parts[4]==="execute")return route.fulfill({json:{card,execution:{requestId:`request-${card.id}`,sessionId:"home-session",state:"started"}}});
  }else reads.push(card.id);
  return route.fulfill({json:{card,reports:[{id:"report",title:"보고",body:"보고",format:"markdown",createdAt:card.createdAt,sessionId:null}],
   questions:card.id==="home-3-0"?[{id:"q",text:"질문",answer:null,options:null,askedAt:"",answeredAt:null}]:[],sessions:[]}});
 });
 await page.goto(process.env.CARD1680_VISUAL_BASE??"/");await expect(page.getByTestId("card-home")).toBeVisible({timeout:30_000});
 const board=page.getByTestId("card-home").locator(".v3-card-board");await expect(board).toBeVisible({timeout:30_000});
 return {cards,reads,completedReads,writes,creates,board,releaseFolder,setFolderFailure:(value:boolean)=>{folderFailure=value;},setFailure:(value:boolean)=>{failure=value;},setDelay:(value:boolean)=>{delay=value;},setCompletedFailure:(value:boolean)=>{completedFailure=value;}};
}
const capture=async(page:Page,name:string)=>{mkdirSync(output,{recursive:true});await page.screenshot({path:path.join(output,`${name}.png`),animations:"disabled"});};
const captureEmptyLanes=async(page:Page,name:string)=>{mkdirSync(emptyLanesOutput,{recursive:true});await page.screenshot({path:path.join(emptyLanesOutput,`${name}.png`),animations:"disabled"});};

for(const [width,height] of [[390,844],[1440,900]])test(`카드 홈 완료 포함 목록 보기 높이 ${width}`,async({page})=>{
 const artifacts=path.resolve(process.env.CARD_HOME_ARTIFACTS??output),phase=process.env.CARD_HOME_PHASE??"after";
 mkdirSync(artifacts,{recursive:true});
 await page.setViewportSize({width,height});await page.emulateMedia({reducedMotion:"reduce"});
 const {board}=await fixture(page,17,seed(),5),home=page.getByTestId("card-home");
 await home.locator('[role="switch"][aria-label="완료·취소 숨김"]').uncheck();
 const done=board.locator('[data-board-column="done"]'),boardViewport=done.getByTestId("completed-viewport");
 await expect(done).toContainText("6개 표시");await boardViewport.scrollIntoViewIfNeeded();
 const boardScroller=boardViewport.getByTestId("virtuoso-scroller"),boardCard=boardScroller.locator("[data-card-id]").first();
 await expect(boardCard).toBeVisible();
 const boardMetrics={viewport:await boardViewport.boundingBox(),scroller:await boardScroller.boundingBox(),firstCard:await boardCard.boundingBox()};
 await page.screenshot({path:path.join(artifacts,`${phase}-${width}-board.png`),animations:"disabled"});
 expect(boardMetrics.viewport!.height).toBeGreaterThanOrEqual(200);
 await home.getByRole("button",{name:"일반 보기",exact:true}).click();
 const listViewport=home.getByTestId("completed-viewport"),listScroller=listViewport.getByTestId("virtuoso-scroller");
 await expect(home.locator(".v3-completed-collection")).toContainText("6개 표시");
 await listViewport.scrollIntoViewIfNeeded();await expect(listScroller).toBeAttached();
 const listCard=listScroller.locator(".v3-completed-grid-item").first();
 const queueTitle=home.locator('[data-card-group="queued"] .v3-section-head h2');
 const completedTitle=home.locator(".v3-completed-collection > div > :is(h2,h3)");
 const firstPeriod=home.locator(".v3-completed-collection .v3-completed-periods button").first();
 const queue=home.locator('[data-card-group="queued"]'),running=home.locator('[data-card-group="running"]');
 const queueHead=queue.locator(":scope > .v3-section-head"),completedHead=home.locator(".v3-completed-collection > .v3-section-head");
 const queueCard=queue.locator("[data-card-id]").first().locator("..");
 const typography=async(locator:typeof queueTitle)=>locator.evaluate(element=>{
  const style=getComputedStyle(element);return {fontSize:style.fontSize,fontWeight:style.fontWeight,lineHeight:style.lineHeight};
 });
 const queueHeadBox=(await queueHead.boundingBox())!,completedHeadBox=(await completedHead.boundingBox())!;
 const queueBox=(await queue.boundingBox())!,runningBox=(await running.boundingBox())!;
 const listMetrics={viewport:await listViewport.boundingBox(),scroller:await listScroller.boundingBox(),firstCard:await listCard.boundingBox(),
  typography:{queue:await typography(queueTitle),completed:await typography(completedTitle)},
  starts:{queue:(await queueTitle.boundingBox())!.x,completed:(await completedTitle.boundingBox())!.x,
   period:(await firstPeriod.boundingBox())!.x,card:(await listCard.boundingBox())!.x},
  rhythm:{queueBelow:(await queueCard.boundingBox())!.y-(queueHeadBox.y+queueHeadBox.height),
   completedBelow:(await firstPeriod.boundingBox())!.y-(completedHeadBox.y+completedHeadBox.height),
   queueAbove:queueHeadBox.y-(runningBox.y+runningBox.height),completedAbove:completedHeadBox.y-(queueBox.y+queueBox.height)}};
 await page.screenshot({path:path.join(artifacts,`${phase}-${width}-list.png`),animations:"disabled"});
 await completedHead.evaluate(head=>head.scrollIntoView({block:"center",inline:"nearest",behavior:"instant"}));
 await page.screenshot({path:path.join(artifacts,`${phase}-${width}-seam.png`),animations:"disabled"});
 const metrics={board:boardMetrics,list:listMetrics,resize:null as null|{width:number;height:number;documentWidth:number;clientWidth:number}};
 const metricsPath=path.join(artifacts,`${phase}-${width}-metrics.json`);
 writeFileSync(metricsPath,JSON.stringify(metrics,null,2));
 expect(listMetrics.viewport!.height).toBeGreaterThanOrEqual(200);
 await expect(listCard).toBeVisible();
 expect(listMetrics.firstCard!.x).toBeGreaterThanOrEqual(listMetrics.viewport!.x);
 expect(listMetrics.firstCard!.x+listMetrics.firstCard!.width).toBeLessThanOrEqual(listMetrics.viewport!.x+listMetrics.viewport!.width);
 expect(listMetrics.firstCard!.y).toBeGreaterThanOrEqual(listMetrics.viewport!.y);
 expect(listMetrics.firstCard!.y+listMetrics.firstCard!.height).toBeLessThanOrEqual(listMetrics.viewport!.y+listMetrics.viewport!.height);
 expect.soft(listMetrics.typography.completed,"완료와 대기열 머리 글자").toEqual(listMetrics.typography.queue);
 const starts=Object.values(listMetrics.starts);
 expect.soft(Math.max(...starts)-Math.min(...starts),"대기열·완료·기간·카드 시작선 차이").toBeLessThanOrEqual(1);
 expect.soft(Math.abs(listMetrics.rhythm.completedBelow-listMetrics.rhythm.queueBelow),"머리 아래 간격 차이").toBeLessThanOrEqual(1);
 expect.soft(Math.abs(listMetrics.rhythm.completedAbove-listMetrics.rhythm.queueAbove),"머리 위 간격 차이").toBeLessThanOrEqual(1);
 const resized=width===390?{width:1440,height:900}:{width:390,height:844};
 await page.setViewportSize(resized);
 await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
 await expect.poll(async()=>(await listViewport.boundingBox())!.height).toBeGreaterThanOrEqual(200);
 const overflow=await page.evaluate(()=>({documentWidth:document.documentElement.scrollWidth,clientWidth:document.documentElement.clientWidth}));
 metrics.resize={width:resized.width,height:(await listViewport.boundingBox())!.height,...overflow};
 writeFileSync(metricsPath,JSON.stringify(metrics,null,2));
 if(resized.width===390)expect(overflow.documentWidth).toBeLessThanOrEqual(overflow.clientWidth);
 if(width===1440){
  await page.setViewportSize({width,height});
  await page.getByTestId("v3-all-projects").getByRole("button",{name:"소울스트림",exact:true}).click();
  const folder=page.getByTestId("folder-card-section");
  await folder.locator('[role="switch"][aria-label="완료·취소 숨김"]').uncheck();
  await folder.getByRole("button",{name:"일반 보기",exact:true}).click();
  const folderCollection=folder.locator(".v3-completed-collection");
  await expect(folderCollection.locator(".v3-detail-section-head > h3")).toHaveText("완료");
  await folderCollection.getByTestId("completed-viewport").scrollIntoViewIfNeeded();
  await folderCollection.locator(".v3-detail-section-head").scrollIntoViewIfNeeded();
  await page.screenshot({path:path.join(artifacts,`${phase}-1440-folder-list.png`),animations:"disabled"});
  await page.goto("/components");
  const sample=page.getByTestId("card-board-sample");
  await sample.getByRole("button",{name:"일반 보기",exact:true}).click();
  await sample.locator('[role="switch"][aria-label="완료·취소 숨김"]').uncheck();
  const sampleCollection=sample.locator(".v3-completed-collection");
  await expect(sampleCollection.locator(".v3-detail-section-head > h3")).toHaveText("완료");
  await sampleCollection.getByTestId("completed-viewport").scrollIntoViewIfNeeded();
  await page.screenshot({path:path.join(artifacts,`${phase}-1440-components-list.png`),animations:"disabled"});
 }
});

test("completed grid restores main scroll across expansion and resets after search",async({page},testInfo)=>{
 await page.setViewportSize({width:390,height:844});await page.emulateMedia({reducedMotion:"reduce"});
 const state=await fixture(page,17,seed(),24),home=page.getByTestId("card-home");
 await home.getByRole("switch",{name:"완료·취소 숨김"}).click();
 const mainScroller=state.board.locator('[data-board-column="done"] [data-testid="virtuoso-scroller"]');
 await mainScroller.scrollIntoViewIfNeeded();await mainScroller.hover();await page.mouse.wheel(0,720);
 await expect.poll(()=>mainScroller.evaluate(element=>element.scrollTop)).toBe(720);
 const positions:Record<string,number>={main:await mainScroller.evaluate(element=>element.scrollTop)};
 await page.screenshot({path:testInfo.outputPath("main-720.png"),animations:"disabled"});
 const expand=()=>home.getByRole("button",{name:"보드 확대",exact:true}).click();
 const dialog=page.getByRole("dialog",{name:"전체 카드 보드",exact:true});
 const expandedScroller=dialog.locator('[data-board-column="done"] [data-testid="virtuoso-scroller"]');
 await expand();await expect.poll(()=>expandedScroller.evaluate(element=>element.scrollTop)).toBe(720);
 positions.expanded=await expandedScroller.evaluate(element=>element.scrollTop);
 await page.screenshot({path:testInfo.outputPath("expanded-720.png"),animations:"disabled"});
 await expandedScroller.scrollIntoViewIfNeeded();await expandedScroller.hover();await page.mouse.wheel(0,-360);
 await expect.poll(()=>expandedScroller.evaluate(element=>element.scrollTop)).toBeLessThan(720);
 positions.expandedMoved=await expandedScroller.evaluate(element=>element.scrollTop);
 await dialog.getByRole("button",{name:"확대 닫기",exact:true}).click();
 await expect.poll(()=>mainScroller.evaluate(element=>element.scrollTop)).toBe(720);
 positions.collapsed=await mainScroller.evaluate(element=>element.scrollTop);
 await expand();await expect.poll(()=>expandedScroller.evaluate(element=>element.scrollTop)).toBe(720);
 positions.reexpanded=await expandedScroller.evaluate(element=>element.scrollTop);
 await dialog.getByRole("button",{name:"확대 닫기",exact:true}).click();
 await home.getByRole("textbox",{name:"제목 또는 요청 검색"}).fill("완료 탐색");
 await expect(state.board.locator('[data-board-column="done"] > .v3-detail-section-head')).toContainText("24개 표시");
 await expect.poll(()=>mainScroller.evaluate(element=>element.scrollTop)).toBe(0);
 positions.searchReset=await mainScroller.evaluate(element=>element.scrollTop);
 await expand();await expect.poll(()=>expandedScroller.evaluate(element=>element.scrollTop)).toBe(0);
 positions.resetExpanded=await expandedScroller.evaluate(element=>element.scrollTop);
 await dialog.getByRole("button",{name:"확대 닫기",exact:true}).click();
 await page.screenshot({path:testInfo.outputPath("search-reset-0.png"),animations:"disabled"});
 writeFileSync(testInfo.outputPath("completed-scroll-positions.json"),JSON.stringify({positions,writes:state.writes,creates:state.creates},null,2));
 expect(state.writes).toEqual([]);expect(state.creates).toEqual([]);
});

test("main and folder boards hide empty lanes and restore the current lane across membership changes",async({page})=>{
 const laneCards=Array.from({length:6},(_,index)=>({...reviewCard,id:`running-${index}`,folderId:"folder-amber",title:`실행 카드 ${index+1}`,status:"running" as const,positionKey:String(index)}));
 const cards=[...laneCards,{...reviewCard,id:"review-card",folderId:"folder-amber",title:"검수 카드",status:"review" as const},
  {...reviewCard,id:"done-card",folderId:"folder-amber",title:"완료한 카드",status:"done" as const,completedAt:reviewCard.createdAt},
  {...reviewCard,id:"cancelled-card",folderId:"folder-amber",title:"취소한 카드",status:"cancelled" as const}];
 await page.setViewportSize({width:390,height:844});await page.emulateMedia({reducedMotion:"reduce"});
 const state=await fixture(page,17,cards,24),home=page.getByTestId("card-home"),board=state.board;
 await captureEmptyLanes(page,`${emptyLanesPhase}-390-main`);
 await page.setViewportSize({width:1440,height:1000});await captureEmptyLanes(page,`${emptyLanesPhase}-1440-main`);
 await page.setViewportSize({width:390,height:844});
 const columnStatuses=()=>board.locator("[data-board-column]").evaluateAll(columns=>columns.map(column=>column.getAttribute("data-board-column")));
 expect(await columnStatuses()).toEqual(["running","review"]);
 const create=home.locator(".v3-card-actions").getByRole("button",{name:"새 카드",exact:true});await expect(create).toBeVisible();
 const running=board.locator('[data-board-column="running"]'),runningLane=running.locator(".v3-card-board-lane");
 await runningLane.hover();await page.mouse.wheel(0,500);await expect.poll(()=>runningLane.evaluate(element=>element.scrollTop)).toBeGreaterThan(0);
 const originalRunningX=(await running.boundingBox())!.x,originalRunningScroll=await runningLane.evaluate(element=>element.scrollTop);
 await create.click();const dialog=page.getByRole("dialog");await expect(dialog).toBeVisible();
 await dialog.getByRole("textbox",{name:"카드 제목"}).fill("새 드래프트");
 await dialog.getByRole("button",{name:"폴더 선택",exact:true}).click();
 await page.locator(".v3-card-folder-picker").getByRole("tab",{name:"전체",exact:true}).click();
 await page.locator(".v3-card-folder-picker").getByRole("button",{name:"소울스트림",exact:true}).click();
 await dialog.getByRole("button",{name:"카드 저장",exact:true}).click();
 const draft=board.locator('[data-card-id="created"]');await expect(draft).toBeVisible();
 expect(await columnStatuses()).toEqual(["todo","running","review"]);
 expect(Math.abs((await running.boundingBox())!.x-originalRunningX)).toBeLessThanOrEqual(1);
 expect(await runningLane.evaluate(element=>element.scrollTop)).toBe(originalRunningScroll);
 await draft.getByRole("button",{name:"카드 상태 변경",exact:true}).click();
 const todoX=(await board.locator('[data-board-column="todo"]').boundingBox())!.x;
 const picker=page.locator("[data-card-status-picker]");await picker.getByRole("button",{name:"대기",exact:true}).click();
 await expect(board.locator('[data-board-column="queued"] [data-card-id="created"]')).toHaveCount(1);
 await expect(board.locator('[data-board-column="todo"]')).toHaveCount(0);
 expect(await columnStatuses()).toEqual(["queued","running","review"]);
 expect(Math.abs((await board.locator('[data-board-column="queued"]').boundingBox())!.x-todoX)).toBeLessThanOrEqual(1);
 expect(await runningLane.evaluate(element=>element.scrollTop)).toBe(originalRunningScroll);
 const completion=home.getByRole("switch",{name:"완료·취소 숨김"});
 await completion.click();await expect(board.locator('[data-board-column="done"]')).toHaveCount(1);await expect(board.locator('[data-board-column="cancelled"]')).toHaveCount(1);
 const completionControls=home.locator(".v3-completed-controls");await expect(completionControls).toHaveCount(1);
 const completedSearch=completionControls.getByRole("textbox",{name:"제목 또는 요청 검색"});await expect(completedSearch).toBeVisible();
 await captureEmptyLanes(page,`${emptyLanesPhase}-390-completion-controls`);
 await page.setViewportSize({width:1440,height:1000});await captureEmptyLanes(page,`${emptyLanesPhase}-1440-completion-controls`);
 await page.setViewportSize({width:390,height:844});
 await completedSearch.fill("검색 결과 없음");await expect(board.locator('[data-board-column="done"]').getByRole("status")).toContainText("선택한 기간에 완료 카드가 없습니다");
 await expect(board.locator('[data-board-column="done"]')).toHaveCount(1);await expect(completionControls).toHaveCount(1);
 await completedSearch.fill("");await expect(board.locator('[data-board-column="done"]')).toHaveCount(1);
 expect(await columnStatuses()).toEqual(["queued","running","review","done","cancelled"]);
 await captureEmptyLanes(page,`${emptyLanesPhase}-390-transition`);
 await page.setViewportSize({width:1440,height:1000});await captureEmptyLanes(page,`${emptyLanesPhase}-1440-transition`);
 await page.setViewportSize({width:390,height:844});
 const mainDone=board.locator('[data-board-column="done"]'),completedScroller=mainDone.locator('[data-testid="virtuoso-scroller"]');
 await completedScroller.scrollIntoViewIfNeeded();await completedScroller.hover();await page.mouse.wheel(0,720);
 await expect.poll(()=>completedScroller.evaluate(element=>element.scrollTop)).toBeGreaterThan(0);
 const mainCompletedScroll=await completedScroller.evaluate(element=>element.scrollTop);
 const mainScroll=await board.evaluate(element=>element.scrollLeft),mainRunningScroll=await runningLane.evaluate(element=>element.scrollTop),mainDoneX=(await mainDone.boundingBox())!.x;
 const horizontalAnchor=(element:HTMLElement)=>{const left=element.getBoundingClientRect().left+element.clientLeft+(parseFloat(getComputedStyle(element).paddingLeft)||0);const column=[...element.querySelectorAll<HTMLElement>("[data-board-column]")].find(item=>item.getBoundingClientRect().right>left)!;return {status:column.dataset.boardColumn!,offset:column.getBoundingClientRect().left-left};};
 const anchor=await board.evaluate(horizontalAnchor);
 await home.getByRole("button",{name:"보드 확대",exact:true}).click();
 const expanded=page.getByRole("dialog",{name:"전체 카드 보드",exact:true}),expandedBoard=expanded.locator(".v3-card-board");
 await expect(expanded).toBeVisible();
 expect(await expandedBoard.locator("[data-board-column]").evaluateAll(columns=>columns.map(column=>column.getAttribute("data-board-column")))).toEqual(["todo","queued","running","blocked","awaiting_verification","review","on_hold","done","cancelled"]);
 const expandedDone=expandedBoard.locator('[data-board-column="done"]');await expect(expandedDone.locator(".v3-completed-controls")).toHaveCount(1);
 const expandedCompletedScroller=expandedDone.locator('[data-testid="virtuoso-scroller"]');
 await expect.poll(()=>expandedCompletedScroller.evaluate(element=>element.scrollTop)).toBe(mainCompletedScroll);
 await expect(expandedDone.locator('[role="status"]')).toHaveCount(0);
 const expandedActions=expanded.locator(".v3-card-actions"),expandedRunning=expandedBoard.locator('[data-board-column="running"]'),expandedRunningLane=expandedRunning.locator(".v3-card-board-lane");
 await expect(expandedActions.getByRole("button",{name:"새 카드",exact:true})).toBeVisible();
 await expect(expandedActions.getByRole("button",{name:"기록",exact:true})).toHaveCount(0);
 await expect(expandedRunningLane).toHaveJSProperty("scrollTop",mainRunningScroll);
 const expandedAnchor=await expandedBoard.evaluate(horizontalAnchor);
 expect(expandedAnchor.status).toBe(anchor.status);expect(Math.abs(expandedAnchor.offset-anchor.offset)).toBeLessThanOrEqual(1);
 await expandedBoard.evaluate(element=>element.scrollLeft=element.scrollWidth);
 await expandedCompletedScroller.hover();await page.mouse.wheel(0,-720);
 await expect.poll(()=>expandedCompletedScroller.evaluate(element=>element.scrollTop)).toBeLessThan(mainCompletedScroll);
 await expandedRunningLane.evaluate(element=>element.scrollTop=0);
 await expandedActions.getByRole("button",{name:"확대 닫기",exact:true}).click();await expect(expanded).toHaveCount(0);
 await expect.poll(()=>board.evaluate(element=>element.scrollLeft)).toBe(mainScroll);
 await expect.poll(()=>completedScroller.evaluate(element=>element.scrollTop)).toBe(mainCompletedScroll);
 expect(Math.abs((await mainDone.boundingBox())!.x-mainDoneX)).toBeLessThanOrEqual(1);
 expect(await runningLane.evaluate(element=>element.scrollTop)).toBe(mainRunningScroll);
 await completion.click();await expect(board.locator('[data-board-column="done"]')).toHaveCount(0);await expect(board.locator('[data-board-column="cancelled"]')).toHaveCount(0);
 await expect(home.locator(".v3-completed-controls")).toHaveCount(0);
 await captureEmptyLanes(page,`${emptyLanesPhase}-390-restored`);

 await page.setViewportSize({width:1440,height:1000});
 await page.getByTestId("v3-all-projects").getByRole("button",{name:"소울스트림",exact:true}).click();
 const folder=page.getByTestId("folder-card-section"),folderBoard=folder.locator(".v3-card-board");await expect(folderBoard).toBeVisible();
 expect(await folderBoard.locator("[data-board-column]").evaluateAll(columns=>columns.map(column=>column.getAttribute("data-board-column")))).toEqual(["queued","running","review"]);
 await expect(folder.locator(".v3-card-actions").getByRole("button",{name:"새 카드",exact:true})).toBeVisible();
 await folder.getByRole("button",{name:"보드 확대",exact:true}).click();
 const folderExpanded=page.getByRole("dialog",{name:"현재 폴더 카드 보드",exact:true});
 expect(await folderExpanded.locator("[data-board-column]").evaluateAll(columns=>columns.map(column=>column.getAttribute("data-board-column")))).toEqual(["todo","queued","running","blocked","awaiting_verification","review","on_hold"]);
 await expect(folderExpanded.locator(".v3-card-actions").getByRole("button",{name:"새 카드",exact:true})).toBeVisible();
 await folderExpanded.getByRole("button",{name:"확대 닫기",exact:true}).click();
 await expect(folderExpanded).toHaveCount(0);

 await page.goto("/components");const sample=page.getByTestId("card-board-sample"),sampleBoard=sample.locator(".v3-card-board");
 await sample.getByRole("button",{name:"빈 보드",exact:true}).click();
 await expect(sampleBoard.locator("[data-board-column]")).toHaveCount(0);
 await expect(sampleBoard.locator(".v3-card-board-empty")).toHaveCount(1);
 await expect(sample.locator(".v3-card-actions").getByRole("button",{name:"새 카드",exact:true})).toBeVisible();
 await sample.getByRole("button",{name:"혼합",exact:true}).click();
 expect(await sampleBoard.locator("[data-board-column]").evaluateAll(columns=>columns.map(column=>column.getAttribute("data-board-column")))).toEqual(["todo","running","awaiting_verification","review","on_hold"]);
 expect(state.writes).toHaveLength(1);
});
for(const [width,font] of [[390,17],[1210,14],[1440,17],[1920,18]])test(`product layout ${width} font ${font}`,async({page})=>{
 await page.setViewportSize({width,height:width===1210?834:1000});await page.emulateMedia({reducedMotion:"reduce"});
 const state=await fixture(page,font),home=page.getByTestId("card-home");await page.evaluate(()=>document.fonts.ready);
 expect(state.reads).toEqual([]);await home.getByRole("switch",{name:"완료·취소 숨김"}).click();await expect(home.locator('[data-card-status="done"]')).toHaveCount(1);
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
 await expect(home.getByRole("button",{name:"기록",exact:true})).toHaveCount(0);
 await expect(home).toBeVisible();
 if(width===390){await page.getByTestId("v3-mobile-tab-projects").click();await page.getByTestId("v3-mobile-project-list").getByRole("button",{name:"소울스트림",exact:true}).click();}
 else await page.getByTestId("v3-all-projects").getByRole("button",{name:"소울스트림",exact:true}).click();
 const folder=page.getByTestId("folder-card-section");await folder.scrollIntoViewIfNeeded();await expect(folder.locator('[data-card-status="done"]')).toHaveCount(0);
 await capture(page,`after-folder-${width}-font${font}`);
 const review=folder.locator('[data-card-id="home-4-0"]');await review.scrollIntoViewIfNeeded();await review.click({button:"right"});
 if(width===390)await page.getByTestId("v3-context-menu-mobile").getByRole("button",{name:"완료",exact:true}).click();
 else await page.locator('[data-slot="menu-popup"]').getByRole("menuitem",{name:"완료",exact:true}).click();
 await expect(folder.locator('[data-card-id="home-4-0"]')).toHaveCount(0);
 await folder.getByRole("switch",{name:"완료·취소 숨김"}).uncheck();await expect(folder.locator('[data-card-status="done"]')).toHaveCount(2);
 expect(state.writes).toHaveLength(1);writeFileSync(path.join(output,`metrics-${width}-font${font}.json`),JSON.stringify({metrics,expandedRect,restoredHorizontal:old,reads:state.reads,writes:state.writes},null,2));
});

test("actual component samples support expansion without API writes",async({page})=>{
 await page.setViewportSize({width:1210,height:834});await fixture(page,17);const writes:string[]=[];page.on("request",r=>{if(r.method()!=="GET"&&new URL(r.url()).pathname.startsWith("/api/cards"))writes.push(r.url());});
 await page.goto("/components");const sample=page.getByTestId("card-board-sample");const board=sample.locator(".v3-card-board");await board.scrollIntoViewIfNeeded();
 const originalScroll=await board.evaluate(el=>el.scrollLeft);
 await sample.getByRole("button",{name:"보드 확대",exact:true}).click();const expanded=page.getByRole("dialog",{name:"현재 폴더 카드 보드"});await expect(expanded).toBeVisible();
 const bounds=await expanded.evaluate(el=>{const rect=el.getBoundingClientRect();return {x:rect.x,y:rect.y,width:rect.width,height:rect.height,centerOwned:el.contains(document.elementFromPoint(innerWidth/2,innerHeight/2))};});expect(bounds).toEqual({x:20,y:20,width:1170,height:794,centerOwned:true});writeFileSync(path.join(output,"components-expanded-metrics.json"),JSON.stringify(bounds,null,2));await capture(page,"after-components-expanded");await expanded.getByRole("switch",{name:"완료·취소 숨김"}).uncheck();await expect(expanded.getByRole("switch",{name:"완료·취소 숨김"})).not.toBeChecked();await expanded.locator(".v3-card-board").evaluate(el=>el.scrollLeft=el.scrollWidth);
 await page.keyboard.press("Escape");expect(await board.evaluate(el=>el.scrollLeft)).toBe(originalScroll);await expect(sample.locator('.v3-card-board-workspace').getByRole("switch",{name:"완료·취소 숨김"})).not.toBeChecked();await expect(sample.getByRole("button",{name:"보드 확대",exact:true})).toBeFocused();expect(writes).toEqual([]);
});


test("Escape closes the current context menu before the expanded board",async({page})=>{
 await page.setViewportSize({width:1210,height:834});const state=await fixture(page);
 await page.getByRole("button",{name:"보드 확대",exact:true}).click();const dialog=page.getByRole("dialog",{name:"전체 카드 보드"}),board=dialog.locator(".v3-card-board");
 const review=board.locator('[data-card-id="home-4-0"]');await review.scrollIntoViewIfNeeded();await review.click({button:"right"});
 const picker=page.locator('[data-slot="menu-popup"]');await expect(picker.getByRole("menuitem",{name:"실행 중",exact:true})).toBeEnabled();
 await page.keyboard.press("Escape");await expect(picker).toHaveCount(0);await expect(dialog).toBeVisible();expect(state.writes).toHaveLength(0);await expect(page.getByTestId("card-detail")).toHaveCount(0);
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
 await expect(state.board.locator('[data-card-id="external"]')).toHaveCount(1);await expect(page.getByTestId("card-home").locator('.v3-folder-card-head')).toContainText("10개");
 state.cards.splice(state.cards.findIndex(card=>card.id==="external"),1);await page.evaluate(()=>(window as unknown as {emitCard(id:string):void}).emitCard("external"));await expect(state.board.locator('[data-card-id="external"]')).toHaveCount(0);await expect(page.getByTestId("card-home").locator('.v3-folder-card-head')).toContainText("9개");
 writeFileSync(path.join(output,"membership.json"),JSON.stringify({creates:state.creates,duplicates:0,removed:true},null,2));await capture(page,"after-created-and-sse");
});


test("pending and failed status saves block duplicates and retry without a reason",async({page})=>{
 await page.setViewportSize({width:1440,height:1000});const state=await fixture(page),review=state.board.locator('[data-card-id="home-4-0"]');await review.scrollIntoViewIfNeeded();await review.getByRole("button",{name:"카드 상태 변경",exact:true}).click();const picker=page.locator('[data-card-status-picker]');
 state.setFailure(true);state.setDelay(true);const save=picker.getByRole("button",{name:"실행 중",exact:true});await save.click();await expect(save).toBeDisabled();expect(state.writes).toHaveLength(1);
 await expect(picker.getByRole("alert").first()).toHaveText("카드가 변경되었습니다. 최신 상태를 확인해 주세요.");
 const retry=picker.getByRole("button",{name:"다시 시도",exact:true});await expect(retry).toBeVisible();state.setFailure(false);state.setDelay(false);await retry.click();
 await expect(state.board.locator('[data-board-column="running"] [data-card-id="home-4-0"]')).toHaveCount(1);expect(state.writes).toHaveLength(2);expect(state.writes[1]).toMatchObject({id:"home-4-0",endpoint:"/execute",body:{expectedVersion:reviewCard.version}});expect(state.writes[1].body).not.toHaveProperty("status");expect(state.writes[1].body).not.toHaveProperty("reason");
});

test.describe("touch alternative",()=>{
 test.use({hasTouch:true,viewport:{width:390,height:844}});
 test("the existing status chip exposes the same free transition",async({page})=>{
  const state=await fixture(page),review=state.board.locator('[data-card-id="home-4-0"]');await review.scrollIntoViewIfNeeded();await review.getByRole("button",{name:"카드 상태 변경",exact:true}).tap();
  await page.locator('[data-card-status-picker]').getByRole("button",{name:"완료",exact:true}).tap();await expect(state.board.locator('[data-card-id="home-4-0"]')).toHaveCount(0);expect(state.writes).toHaveLength(1);expect(state.writes[0]).toMatchObject({id:"home-4-0",endpoint:"/status",body:{status:"done",expectedVersion:reviewCard.version}});await expect(page.getByTestId("card-detail")).toHaveCount(0);writeFileSync(path.join(output,"touch-menu.json"),JSON.stringify(state.writes,null,2));
 });
});

const completedArtifacts=path.resolve(process.env.CARD_HOME_ARTIFACTS??output);
const completedPhase=process.env.CARD_HOME_PHASE??"after";
async function completedCapture(page:Page,name:string,metrics:unknown){
 mkdirSync(completedArtifacts,{recursive:true});
 await page.screenshot({path:path.join(completedArtifacts,`${completedPhase}-completed-${name}.png`),animations:"disabled"});
 writeFileSync(path.join(completedArtifacts,`${completedPhase}-completed-${name}-metrics.json`),JSON.stringify(metrics,null,2));
}
async function completedList(page:Page,folder=false){
 const home=page.getByTestId("card-home");
 if(folder)await openCompletedFolder(page);
 const surface=folder?page.getByTestId("folder-card-section"):home;
 await surface.getByRole("switch",{name:"완료·취소 숨김"}).uncheck();
 await surface.getByRole("button",{name:"일반 보기",exact:true}).click();
 return surface.locator(".v3-completed-collection");
}
async function openCompletedFolder(page:Page){
 if((page.viewportSize()?.width??0)<=430){
  await page.getByTestId("v3-mobile-tab-projects").click();
  await page.getByTestId("v3-mobile-project-list").getByRole("button",{name:"소울스트림",exact:true}).click();
 }else await page.getByTestId("v3-all-projects").getByRole("button",{name:"소울스트림",exact:true}).click();
}

const card1698Dir=path.resolve(`../.local/card1698/captures/${process.env.CARD1698_PHASE??'after'}`);
async function card1698Shot(page:Page,name:string){mkdirSync(card1698Dir,{recursive:true});return page.screenshot({path:path.join(card1698Dir,`${name}.png`),animations:'disabled'});}
async function card1698IconPixels(page:Page,shot:Buffer){
 const buttons=await page.getByTestId('folder-card-section').locator('.v3-card-board-workspace .v3-card-actions button').evaluateAll(nodes=>nodes.map(node=>{
  const svg=node.querySelector('svg')!,r=svg.getBoundingClientRect();return {label:node.getAttribute('aria-label'),rect:{x:r.x,y:r.y,width:r.width,height:r.height},webgl:node.getAttribute('data-liquid-glass-webgl'),filter:getComputedStyle(node).backdropFilter};
 }));
 return page.evaluate(async({encoded,buttons})=>{const img=new Image();img.src=`data:image/png;base64,${encoded}`;await img.decode();const canvas=document.createElement('canvas');canvas.width=img.width;canvas.height=img.height;const ctx=canvas.getContext('2d')!;ctx.drawImage(img,0,0);
  return buttons.map(button=>{const r=button.rect,x=Math.floor(r.x),y=Math.floor(r.y),w=Math.ceil(r.width),h=Math.ceil(r.height);const pixels=ctx.getImageData(x,y,w,h).data;let dark=0;for(let i=0;i<pixels.length;i+=4)if(pixels[i]<100&&pixels[i+1]<100&&pixels[i+2]<100)dark++;return {...button,dark};});
 },{encoded:shot.toString('base64'),buttons});
}
for(const condition of ['lens','no-filter','webgl','gpu-icon'] as const)for(const stateName of ['loading','error'] as const)test(`card1698 시간 측정 ${condition} ${stateName}`,async({page})=>{
 test.skip(process.env.CARD1698_MEASURE!=='1','진단 실행에서만 측정');test.setTimeout(90000);
 await page.setViewportSize({width:390,height:844});await page.emulateMedia({colorScheme:'light',reducedMotion:'reduce'});
 const state=await fixture(page,17,seed(),0,{folderFailure:stateName==='error',folderPending:stateName==='loading',webglGlass:condition==='webgl'});await openCompletedFolder(page);
 const folder=page.getByTestId('folder-card-section'),head=folder.locator('.v3-card-board-workspace > .v3-folder-card-head');
 if(stateName==='error')await expect(folder.getByRole('alert')).toBeVisible();else await expect(folder.getByRole('status',{name:'카드를 불러오는 중…'})).toBeVisible();
 if(condition==='no-filter')await page.addStyleTag({content:'.v3-card-board-workspace .v3-card-actions button { backdrop-filter: none !important; -webkit-backdrop-filter: none !important; }'});
 if(condition==='gpu-icon')await page.addStyleTag({content:'.v3-card-board-workspace .v3-card-actions svg { transform: translateZ(0); }'});
 const webglAvailable=await page.evaluate(()=>!!document.createElement('canvas').getContext('webgl2'));
 const result=[];mkdirSync(card1698Dir,{recursive:true});
 for(const delay of [0,50,150,300,1000]){
  await head.evaluate(el=>{for(let parent=el.parentElement;parent;parent=parent.parentElement)if(parent.scrollHeight>parent.clientHeight)parent.scrollTop=0;});await page.waitForTimeout(300);
  const start=Date.now();await head.scrollIntoViewIfNeeded();const scrolled=Date.now();if(delay)await page.waitForTimeout(delay);
  const shot=await page.screenshot({path:path.join(card1698Dir,`timing-${condition}-${stateName}-${delay}.png`),animations:'disabled'});const captured=Date.now();
  result.push({delay,scrollMs:scrolled-start,captureEndMs:captured-scrolled,buttons:await card1698IconPixels(page,shot)});
 }
 writeFileSync(path.join(card1698Dir,`timing-${condition}-${stateName}.json`),JSON.stringify({webglAvailable,result},null,2));state.releaseFolder();
});
for(const condition of ['lens','no-filter','all-no-filter','ancestors-no-filter','gpu-icon','gpu-actions'] as const)for(const stateName of ['loading','error'] as const)test(`card1698 프레임 측정 ${condition} ${stateName}`,async({page})=>{
 test.skip(process.env.CARD1698_MEASURE!=='1','진단 실행에서만 측정');test.setTimeout(90000);
 await page.setViewportSize({width:390,height:844});await page.emulateMedia({colorScheme:'light',reducedMotion:'reduce'});
 const state=await fixture(page,17,seed(),0,{folderFailure:stateName==='error',folderPending:stateName==='loading'});await openCompletedFolder(page);
 const folder=page.getByTestId('folder-card-section'),head=folder.locator('.v3-card-board-workspace > .v3-folder-card-head');
 if(stateName==='error')await expect(folder.getByRole('alert')).toBeVisible();else await expect(folder.getByRole('status',{name:'카드를 불러오는 중…'})).toBeVisible();
 if(condition==='no-filter')await page.addStyleTag({content:'.v3-card-board-workspace .v3-card-actions button { backdrop-filter: none !important; -webkit-backdrop-filter: none !important; }'});
 if(condition==='all-no-filter')await page.addStyleTag({content:'* { backdrop-filter: none !important; -webkit-backdrop-filter: none !important; }'});
 if(condition==='ancestors-no-filter')await head.evaluate(el=>{for(let parent=el.parentElement;parent;parent=parent.parentElement){parent.style.setProperty('backdrop-filter','none','important');parent.style.setProperty('-webkit-backdrop-filter','none','important');}});
 if(condition==='gpu-icon')await page.addStyleTag({content:'.v3-card-board-workspace .v3-card-actions svg { transform: translateZ(0); }'});
 if(condition==='gpu-actions')await page.addStyleTag({content:'.v3-card-board-workspace .v3-card-actions { transform: translateZ(0); }'});
 await head.evaluate(el=>{for(let parent=el.parentElement;parent;parent=parent.parentElement)if(parent.scrollHeight>parent.clientHeight)parent.scrollTop=0;});await page.waitForTimeout(500);
 const session=await page.context().newCDPSession(page),frames:{timestamp:number;data:string}[]=[];
 session.on('Page.screencastFrame',event=>{frames.push({timestamp:event.metadata.timestamp,data:event.data});void session.send('Page.screencastFrameAck',{sessionId:event.sessionId});});
 await session.send('Page.startScreencast',{format:'png',everyNthFrame:1});await page.waitForTimeout(250);
 const started=await head.evaluate(el=>{const start=Date.now();el.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});return start;});
 await page.waitForTimeout(1200);await session.send('Page.stopScreencast');
 const result=[];for(const frame of frames){const ms=frame.timestamp*1000-started;if(ms>=0)result.push({ms,buttons:await card1698IconPixels(page,Buffer.from(frame.data,'base64'))});}
 mkdirSync(card1698Dir,{recursive:true});writeFileSync(path.join(card1698Dir,`frames-${condition}-${stateName}.json`),JSON.stringify(result,null,2));await session.detach();state.releaseFolder();
});
async function card1698Buttons(page:Page,name:string){
 const head=page.getByTestId('folder-card-section').locator('.v3-card-board-workspace > .v3-folder-card-head');
 await head.scrollIntoViewIfNeeded();await page.waitForTimeout(300);
 const measurements=await head.locator('.v3-card-actions button').evaluateAll(buttons=>buttons.map(button=>{
  const svg=button.querySelector('svg')!,rect=(el:Element)=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};};
  const hit=(el:Element)=>{const r=el.getBoundingClientRect(),target=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {element:target?.outerHTML.slice(0,200),within:!!target&&button.contains(target)};};
  return {label:button.getAttribute('aria-label'),button:rect(button),svg:rect(svg),buttonHit:hit(button),svgHit:hit(svg)};
 }));
 mkdirSync(card1698Dir,{recursive:true});writeFileSync(path.join(card1698Dir,`${name}.json`),JSON.stringify(measurements,null,2));
 await card1698Shot(page,`${name}-viewport`);
 await page.screenshot({path:path.join(card1698Dir,`${name}-fullpage.png`),fullPage:true,animations:'disabled'});
 await head.locator('.v3-card-actions').screenshot({path:path.join(card1698Dir,`${name}-element.png`),animations:'disabled'});
 for(const item of measurements){expect(item.buttonHit.within).toBe(true);expect(item.svgHit.within).toBe(true);}
}
for(const width of [390,1440])for(const failed of [true,false])test(`card1698 단추 진단 ${width} ${failed?'실패':'빈 목록'}`,async({page})=>{
 await page.setViewportSize({width,height:width===390?844:900});await page.emulateMedia({colorScheme:'light',reducedMotion:'reduce'});
 await fixture(page,17,failed?seed():[],0,{folderFailure:failed});await openCompletedFolder(page);
 const folder=page.getByTestId('folder-card-section');
 if(failed)await expect(folder.getByRole('alert')).toBeVisible();else await expect(folder.getByText('0개 표시')).toBeVisible();
 await card1698Buttons(page,`buttons-${failed?'error':'empty'}-${width}`);
});

for(const width of [390,1440])test(`card1698 초점 링과 첫 줄 ${width}`,async({page})=>{
 await page.setViewportSize({width,height:width===390?844:900});await page.emulateMedia({colorScheme:'light',reducedMotion:'reduce'});
 await fixture(page);const home=page.getByTestId('card-home');const expand=home.getByRole('button',{name:'보드 확대',exact:true});
 await expand.focus();await page.keyboard.press('Shift+Tab');await page.keyboard.press('Tab');await expect(expand).toBeFocused();
 const ring=async()=>expand.evaluate(button=>{
  const r=button.getBoundingClientRect(),clips=[];for(let el=button.parentElement;el;el=el.parentElement){
   const style=getComputedStyle(el),box=el.getBoundingClientRect();
   if(style.overflowX!=='visible'||style.overflowY!=='visible')clips.push({name:el.className,overflowX:style.overflowX,overflowY:style.overflowY,
    left:box.left+el.clientLeft,right:box.left+el.clientLeft+el.clientWidth,top:box.top+el.clientTop,bottom:box.top+el.clientTop+el.clientHeight});
  }return {ring:{left:r.left-4,right:r.right+4,top:r.top-4,bottom:r.bottom+4},clips};
 });
 const verifyRing=async()=>{const data=await ring();for(const clip of process.env.CARD1698_PHASE==='before'?[]:data.clips){
  if(clip.overflowX!=='visible'){expect(data.ring.left,`${clip.name} left`).toBeGreaterThanOrEqual(clip.left-1);expect(data.ring.right,`${clip.name} right`).toBeLessThanOrEqual(clip.right+1);}
  if(clip.overflowY!=='visible'){expect(data.ring.top,`${clip.name} top`).toBeGreaterThanOrEqual(clip.top-1);expect(data.ring.bottom,`${clip.name} bottom`).toBeLessThanOrEqual(clip.bottom+1);}
 }return data;};
 const geometry=async(selector:string)=>page.locator(selector).evaluate(row=>{const planner=row.closest<HTMLElement>('.v3-planner')!,scroll=planner.querySelector<HTMLElement>('.v3-planner-scroll')!,style=getComputedStyle(planner),b=planner.getBoundingClientRect(),s=scroll.getBoundingClientRect();
  const list=planner.querySelector<HTMLElement>('.v3-today-list'),board=planner.querySelector<HTMLElement>('.v3-card-board-column');
  return {rowTop:row.getBoundingClientRect().top,contentTop:b.top+parseFloat(style.borderTopWidth)+parseFloat(style.paddingTop),scrollBottom:s.bottom,listHeight:list?.getBoundingClientRect().height,boardHeight:board?.getBoundingClientRect().height};});
 const before=await verifyRing(),homeGeometry=await geometry('.v3-card-home .v3-folder-card-head');await card1698Shot(page,`home-focus-${width}`);
 await page.keyboard.press('Enter');const dialog=page.getByRole('dialog',{name:'전체 카드 보드'});await expect(dialog).toBeVisible();
 await expect(dialog.getByRole('button',{name:'확대 닫기'})).toBeFocused();await page.keyboard.press('Escape');await expect(expand).toBeFocused();
 const restored=await verifyRing();await card1698Shot(page,`home-restored-${width}`);
 expect(Math.abs(homeGeometry.rowTop-homeGeometry.contentTop)).toBeLessThanOrEqual(1);
 mkdirSync(card1698Dir,{recursive:true});writeFileSync(path.join(card1698Dir,`geometry-${width}.json`),JSON.stringify({before,restored,homeGeometry},null,2));
});

for(const width of [390,1440])test(`card1698 폴더 로딩 오류 복구 ${width}`,async({page})=>{
 await page.setViewportSize({width,height:width===390?844:900});await page.emulateMedia({colorScheme:'light',reducedMotion:'reduce'});
 const state=await fixture(page,17,seed(),0,{folderFailure:true,folderPending:true});await openCompletedFolder(page);
 const folder=page.getByTestId('folder-card-section');
 const unknown=async(board:boolean)=>{await expect(folder).not.toContainText(/\d+개 표시|카드가 없습니다/);await expect(folder.locator('.v3-card-board, .v3-postit-grid')).toHaveCount(0);await expect(folder.getByRole('button',{name:'보드 확대'})).toHaveCount(0);
  await expect(folder.getByRole('switch',{name:'완료·취소 숨김'})).toBeVisible();await expect(folder.getByRole('button',{name:board?'새 카드':'카드 추가',exact:true})).toBeVisible();};
 await unknown(true);await expect(folder.getByRole('status',{name:'카드를 불러오는 중…'})).toBeVisible();await folder.locator('.v3-folder-card-head').scrollIntoViewIfNeeded();const loadingShot=await card1698Shot(page,`loading-board-${width}`);
 if(width===390)for(const button of await card1698IconPixels(page,loadingShot))expect(button.dark,`loading ${button.label}`).toBeGreaterThan(0);
 await folder.getByRole('button',{name:'일반 보기',exact:true}).click();await unknown(false);await expect(folder.getByRole('status',{name:'카드를 불러오는 중…'})).toBeVisible();await card1698Shot(page,`loading-list-${width}`);
 state.releaseFolder();await expect(folder.getByRole('alert')).toBeVisible();await unknown(false);await expect(folder.getByRole('status')).toHaveCount(0);await card1698Shot(page,`error-list-${width}`);
 await folder.getByRole('button',{name:'보드',exact:true}).click();await unknown(true);await folder.getByRole('alert').scrollIntoViewIfNeeded();const errorShot=await card1698Shot(page,`error-board-${width}`);
 if(width===390)for(const button of await card1698IconPixels(page,errorShot))expect(button.dark,`error ${button.label}`).toBeGreaterThan(0);
 await card1698Buttons(page,`buttons-after-error-${width}`);
 state.setFolderFailure(false);await folder.getByRole('button',{name:'다시 불러오기'}).click();await expect(folder.getByRole('alert')).toHaveCount(0);await expect(folder.getByText(/\d+개 표시/).first()).toBeVisible();
 await expect(folder.locator('.v3-card-board')).toBeVisible();await expect(folder.getByRole('button',{name:'보드 확대'})).toBeVisible();await card1698Shot(page,`normal-board-${width}`);
});

for(const [folder,width] of [[false,1440],[false,390],[false,360],[true,390],[true,360]] as const){
 test(`완료 목록 폭 ${folder?"폴더":"카드 홈"} ${width}`,async({page})=>{
  await page.setViewportSize({width,height:900});await fixture(page,17,seed(),5);
  const collection=await completedList(page,folder),viewport=collection.getByTestId("completed-viewport");
  await expect(collection).toContainText("6개 표시");await viewport.scrollIntoViewIfNeeded();
  const scroller=viewport.getByTestId("virtuoso-scroller"),item=scroller.locator(".v3-completed-grid-item").first();
  await expect(item).toBeVisible();
  const metrics=await scroller.evaluate(el=>{
   const viewport=el.closest('[data-testid="completed-viewport"]')!.getBoundingClientRect(),item=el.querySelector('.v3-completed-grid-item')!.getBoundingClientRect(),card=el.querySelector('.v3-postit-card')!.getBoundingClientRect();
   return {viewport:{left:viewport.left,right:viewport.right},item:{left:item.left,right:item.right,width:item.width},card:{width:parseFloat(getComputedStyle(el.querySelector('.v3-postit-card')!).width),visualWidth:card.width},scrollWidth:el.scrollWidth,clientWidth:el.clientWidth,documentWidth:document.documentElement.scrollWidth,windowWidth:document.documentElement.clientWidth};
  });
  await completedCapture(page,`${folder?"folder":"home"}-${width}`,metrics);
  expect(metrics.item.right).toBeLessThanOrEqual(metrics.viewport.right+1);
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth+1);
  if(width===1440)expect(metrics.card.width).toBeCloseTo(320,0);
 });
}

for(const mode of ["목록","보드"] as const){
 test(`완료 목록 여러 번 휠 ${mode}`,async({page})=>{
  await page.emulateMedia({reducedMotion:"reduce"});await page.setViewportSize({width:1440,height:900});
  const state=await fixture(page,17,seed().filter(card=>card.status!=="done"),1000,{paginate:true}),home=page.getByTestId("card-home");
  await home.getByRole("switch",{name:"완료·취소 숨김"}).uncheck();
  if(mode==="목록")await home.getByRole("button",{name:"일반 보기",exact:true}).click();
  const viewport=mode==="목록"?home.locator('.v3-completed-collection [data-testid="completed-viewport"]'):state.board.locator('[data-board-column="done"] [data-testid="completed-viewport"]');
  const scroller=viewport.getByTestId("virtuoso-scroller");await scroller.scrollIntoViewIfNeeded();await expect(scroller.locator('[data-card-id]').first()).toBeVisible();
  const overflowAnchor=await scroller.evaluate(element=>getComputedStyle(element).overflowAnchor);
  if(mode==="보드"){
   const cardWidth=await scroller.locator('.v3-postit-card').first().evaluate(el=>parseFloat(getComputedStyle(el).width));
   expect(cardWidth).toBeCloseTo(256,0);
  }
  const box=(await scroller.boundingBox())!;await page.mouse.move(box.x+box.width/2,(Math.max(box.y,0)+Math.min(box.y+box.height,900))/2);const positions:number[]=[];
  for(let i=0;i<40;i++){await page.mouse.wheel(0,100);await page.waitForTimeout(60);positions.push(await scroller.evaluate(el=>el.scrollTop));}
  const visible=await scroller.locator('[data-card-id]').evaluateAll(els=>els.filter(el=>{const r=el.getBoundingClientRect(),s=el.closest('[data-testid="virtuoso-scroller"]')!.getBoundingClientRect();return r.bottom>s.top&&r.top<s.bottom;}).length);
  await completedCapture(page,`wheel-${mode}`,{positions,visible,overflowAnchor});
  expect(positions.every((position,index)=>index===0||position>=positions[index-1]-1)).toBe(true);
  expect(positions.at(-1)).toBeGreaterThanOrEqual(3600);expect(visible).toBeGreaterThan(0);
  expect(overflowAnchor).toBe("none");
 });
}

for(const [mode,width] of [["목록",390],["폴더",390],["접힌 보드",390],["접힌 보드",1440],["폴더 보드",390],["폴더 보드",1440]] as const){
 test(`완료 목록 오류와 재시도 ${mode} ${width}`,async({page})=>{
  await page.setViewportSize({width,height:width===390?844:900});const state=await fixture(page,17,seed(),5,{fail:true});
  const home=page.getByTestId("card-home");let surface=home;
  if(mode==="폴더"||mode==="폴더 보드"){
   await openCompletedFolder(page);surface=page.getByTestId("folder-card-section");
  }
  await surface.getByRole("switch",{name:"완료·취소 숨김"}).uncheck();
  if(mode==="목록"||mode==="폴더")await surface.getByRole("button",{name:"일반 보기",exact:true}).click();
  const alert=surface.getByRole("alert");await expect(alert).toHaveCount(1);
  await alert.scrollIntoViewIfNeeded();
  const search=surface.getByRole("textbox",{name:"제목 또는 요청 검색"});
  const noticeBox=(await alert.boundingBox())!,searchBox=(await search.boundingBox())!;
  const edges={notice:{left:noticeBox.x,right:noticeBox.x+noticeBox.width},search:{left:searchBox.x,right:searchBox.x+searchBox.width}};
  await completedCapture(page,`error-${mode}-${width}`,{alerts:await alert.count(),text:await alert.innerText(),...edges});
  if(mode==="접힌 보드"||mode==="폴더 보드"){
   await expect(surface.locator('[data-board-column="done"] [data-testid="completed-viewport"] [role="alert"]')).toBeVisible();
  }
  await expect(alert).toContainText("완료 카드를 불러오지 못했습니다.");
  await expect(surface).not.toContainText("Error:");await expect(surface).not.toContainText("선택한 기간에 완료 카드가 없습니다");
  state.setCompletedFailure(false);await alert.getByRole("button",{name:"다시 불러오기"}).click();
  await expect(surface.locator('[data-card-id="home-5-0"]')).toBeVisible();
 });
}

test("완료 목록 로딩과 조작",async({page})=>{
 await page.setViewportSize({width:390,height:844});await fixture(page,17,seed(),5,{delay:3000});
 const collection=await completedList(page),viewport=collection.getByTestId("completed-viewport");await viewport.scrollIntoViewIfNeeded();
 await expect(collection).toContainText("완료 카드를 불러오는 중");
 await completedCapture(page,"loading",{text:await collection.innerText()});
 expect(await collection.innerText()).not.toContain("0개 표시");
 await expect(collection).toContainText("6개 표시",{timeout:10000});
 const search=collection.getByRole("textbox",{name:"제목 또는 요청 검색"});await search.focus();await expect(search).toBeFocused();
 await page.keyboard.press("Tab");const focusAfterTab=await page.evaluate(()=>({tag:document.activeElement?.tagName,visible:!!(document.activeElement as HTMLElement)?.getClientRects().length}));
 expect(focusAfterTab.visible).toBe(true);expect(focusAfterTab.tag).not.toBe("BODY");
 await search.fill("완료");await expect(collection).toContainText("5개 표시",{timeout:10000});
 const scroller=viewport.getByTestId("virtuoso-scroller");await scroller.evaluate(el=>el.scrollTop=100);
 const beforeResize=await scroller.evaluate(el=>el.scrollTop);await page.setViewportSize({width:1440,height:900});
 await expect(search).toHaveValue("완료");const afterResize=await scroller.evaluate(el=>el.scrollTop);expect(afterResize).toBe(beforeResize);
 const home=page.getByTestId("card-home"),expand=home.getByRole("button",{name:"보드 확대",exact:true});
 await home.getByRole("button",{name:"보드",exact:true}).click();await expand.click();await expect(page.getByRole("dialog",{name:"전체 카드 보드"})).toBeVisible();
 await page.keyboard.press("Escape");await expect(page.getByRole("dialog",{name:"전체 카드 보드"})).toHaveCount(0);await expect(expand).toBeFocused();
 await completedCapture(page,"interaction",{focusAfterTab,beforeResize,afterResize,focusRestored:await expand.evaluate(el=>el===document.activeElement)});
});

test("card1680 실시간 갱신에도 불러온 카드와 스크롤 유지",async({page})=>{
 await page.setViewportSize({width:1440,height:900});await page.emulateMedia({reducedMotion:"reduce"});
 const {board,completedReads}=await fixture(page,17,seed().filter(card=>card.status!=="done"),200,{paginate:true});
 const home=page.getByTestId("card-home");await home.getByRole("switch",{name:"완료·취소 숨김"}).uncheck();
 const done=board.locator('[data-board-column="done"]'),scroller=done.getByTestId("virtuoso-scroller");
 await scroller.scrollIntoViewIfNeeded();
 for(let i=0;i<2;i++){
  const previousHeight=await scroller.evaluate(el=>el.scrollHeight);
  await scroller.evaluate(el=>{el.scrollTop=el.scrollHeight;});
  await expect.poll(async()=>Number((await done.locator('.v3-detail-section-head').innerText()).match(/(\d+)개/)?.[1]??0)).toBeGreaterThanOrEqual(Math.min((i+2)*60,200));
  await expect.poll(()=>scroller.evaluate(el=>el.scrollHeight)).toBeGreaterThan(previousHeight);
 }
 await scroller.evaluate(el=>{el.scrollTop=el.scrollHeight/2;});
 const captureDir=path.resolve('../.local/card1680/captures/after');mkdirSync(captureDir,{recursive:true});
 const before=await scroller.evaluate(el=>el.scrollTop),count=await done.locator('.v3-detail-section-head span').textContent(),requestCount=completedReads.length;
 await page.screenshot({path:path.join(captureDir,'scroll-before.png'),animations:'disabled'});
 const response=page.waitForResponse(response=>response.url().includes('/api/cards?')&&response.url().includes('status=done'));
 await page.evaluate(()=>{(window as unknown as {emitCard:(id:string)=>void}).emitCard('completed-grid-0');});await response;
 await expect(done.locator('.v3-detail-section-head span')).toHaveText(count!);
 await expect.poll(()=>scroller.evaluate(el=>el.scrollTop)).toBe(before);
 await page.waitForTimeout(300);
 const requests=completedReads.slice(requestCount);
 expect(requests).toHaveLength(1);expect(new URLSearchParams(requests[0]).has('cursor')).toBe(false);
 const after=await scroller.evaluate(el=>el.scrollTop),afterCount=await done.locator('.v3-detail-section-head span').textContent();
 await page.screenshot({path:path.join(captureDir,'scroll-after.png'),animations:'disabled'});
 writeFileSync(path.join(captureDir,'scroll.json'),JSON.stringify({before,after,count,afterCount,requests},null,2));
});

test("card1680 접힌 보드 완료 열은 지연 로딩 전후 같은 크기",async({page},testInfo)=>{
 await page.setViewportSize({width:390,height:844});const {board}=await fixture(page,17,seed(),5,{delay:2000});
 await page.getByTestId('card-home').getByRole('switch',{name:'완료·취소 숨김'}).uncheck();
 const done=board.locator('[data-board-column="done"]');await done.scrollIntoViewIfNeeded();
 await expect(done.getByText('완료 카드를 불러오는 중…')).toBeVisible();
 const before=(await done.getByTestId('completed-viewport').boundingBox())!;
 await page.screenshot({path:testInfo.outputPath('loading.png'),animations:'disabled'});
 await expect(done.locator('.v3-detail-section-head')).toContainText('6개 표시');
 const after=(await done.getByTestId('completed-viewport').boundingBox())!;
 expect(after.width).toBeCloseTo(before.width,0);expect(after.height).toBeCloseTo(before.height,0);
});

test("card1680 폴더 390px 글자 17·18 격자 여백",async({page},testInfo)=>{
 for(const size of [17,18]){
  await page.setViewportSize({width:390,height:844});await fixture(page,size);
  await openCompletedFolder(page);
  const folder=page.getByTestId('folder-card-section');await folder.getByRole('button',{name:'일반 보기',exact:true}).click();
  const grid=folder.locator('.v3-postit-grid').first(),card=grid.locator('.v3-postit-card').first();await card.scrollIntoViewIfNeeded();
  const edges=await grid.evaluate(el=>{const scroll=el.closest('.v3-planner-scroll')!,box=scroll.getBoundingClientRect(),style=getComputedStyle(scroll),grid=el.getBoundingClientRect(),card=el.querySelector('.v3-postit-card')!.getBoundingClientRect();return {contentRight:box.right-parseFloat(style.paddingRight),gridRight:grid.right,cardRight:card.right};});
  await page.screenshot({path:testInfo.outputPath(`folder-${size}.png`),animations:'disabled'});
  expect(edges.gridRight).toBeLessThanOrEqual(edges.contentRight+1);expect(edges.cardRight).toBeLessThanOrEqual(edges.contentRight+2);
  await page.unrouteAll({behavior:'wait'});
 }
});

const visualPhase=process.env.CARD1680_VISUAL_PHASE??'after';
const visualDir=path.resolve(`../.local/card1680/captures/${visualPhase}`);
const visualSave=(name:string,data:unknown)=>{mkdirSync(visualDir,{recursive:true});writeFileSync(path.join(visualDir,`${name}.json`),JSON.stringify(data,null,2));};
const visualShot=async(page:Page,name:string)=>{mkdirSync(visualDir,{recursive:true});await page.screenshot({path:path.join(visualDir,`${name}.png`),animations:'disabled'});};

test('visual1680 폴더 여백과 좌표',async({page})=>{
 for(const size of [17,18]){
  await page.setViewportSize({width:390,height:844});await fixture(page,size);
  await openCompletedFolder(page);
  const folder=page.getByTestId('folder-card-section');await folder.getByRole('button',{name:'일반 보기',exact:true}).click();
  const grid=folder.locator('.v3-postit-grid').first(),card=grid.locator('.v3-postit-card').first();await card.scrollIntoViewIfNeeded();
  const edges=await grid.evaluate(el=>{const scroll=el.closest('.v3-planner-scroll')!,bounds=scroll.getBoundingClientRect(),style=getComputedStyle(scroll),grid=el.getBoundingClientRect(),card=el.querySelector('.v3-postit-card')!.getBoundingClientRect();return {contentRight:bounds.right-parseFloat(style.paddingRight),gridRight:grid.right,cardRight:card.right,paddingRight:style.paddingRight};});
  await visualShot(page,`folder-${size}`);visualSave(`folder-${size}`,edges);
  if(visualPhase==='after'){expect(edges.gridRight).toBeLessThanOrEqual(edges.contentRight+1);expect(edges.cardRight).toBeLessThanOrEqual(edges.contentRight+2);}
  await page.unrouteAll({behavior:'wait'});
 }
});

for(const width of [1440,390])test(`visual1680 완료 보드 로딩 ${width}`,async({page})=>{
 await page.setViewportSize({width,height:width===390?844:900});
 const {board}=await fixture(page,17,seed().filter(card=>card.status==='done'),5,{delay:3000});
 await page.getByTestId('card-home').getByRole('switch',{name:'완료·취소 숨김'}).uncheck();
 const loader=page.getByText('완료 카드를 불러오는 중…');await expect(loader).toBeVisible();
 if(visualPhase==='after')await board.locator('[data-board-column="done"]').scrollIntoViewIfNeeded();
 await visualShot(page,`loading-${width}`);
 const lane=board.locator('[data-board-column="done"] [data-testid="completed-viewport"]');
 const before=await lane.count()?await lane.boundingBox():null;
 await expect(loader).toHaveCount(0,{timeout:10000});
 const after=await lane.count()?await lane.boundingBox():null;
 await visualShot(page,`loaded-${width}`);visualSave(`loading-${width}`,{before,after});
 if(visualPhase==='after'){expect(before!.width).toBeCloseTo(after!.width,0);expect(before!.height).toBeCloseTo(after!.height,0);}
});

for(const mode of ['list','folder','board'] as const)test(`visual1680 오류 ${mode}`,async({page})=>{
 test.skip(visualPhase==='before','오류 표본은 변경 후 검수');
 await page.setViewportSize({width:390,height:844});const state=await fixture(page,17,seed(),5,{fail:true});
 let surface=page.getByTestId('card-home');
 if(mode==='folder'){await openCompletedFolder(page);surface=page.getByTestId('folder-card-section');}
 await surface.getByRole('switch',{name:'완료·취소 숨김'}).uncheck();
 if(mode!=='board')await surface.getByRole('button',{name:'일반 보기',exact:true}).click();
 const alert=surface.getByRole('alert');await expect(alert).toHaveCount(1);await alert.scrollIntoViewIfNeeded();
 await expect(alert.getByRole('button',{name:'다시 불러오기'})).toBeVisible();
 await expect(alert).not.toContainText('Error:');await visualShot(page,`error-${mode}-closed`);
 await alert.getByText('기술 상세').click();await visualShot(page,`error-${mode}-open`);
 const text=await alert.innerText();state.setCompletedFailure(false);
 await alert.getByRole('button',{name:'다시 불러오기'}).click();
 await expect(surface.locator('[data-card-id="home-5-0"]')).toBeVisible();
 visualSave(`error-${mode}`,{text,retryRecovered:true,errorPrefix:text.includes('Error:')});
});

for(const width of [1440,390])test(`visual1680 오류 표본 ${width}`,async({page})=>{
 test.skip(visualPhase==='before','표본은 변경 후 추가');
 await page.setViewportSize({width,height:width===390?844:900});await fixture(page);
 await page.goto(new URL('/components',page.url()).toString());
 const sample=page.locator('[data-component="V3ErrorNotice"]');await expect(sample).toBeVisible();await sample.scrollIntoViewIfNeeded();
 await page.waitForTimeout(1000);
 const detail=sample.locator('details').first();
 if(!await detail.evaluate(el=>el.hasAttribute('open')))await detail.locator('summary').click();
 await expect(detail.locator('pre')).toBeVisible();await expect(sample).not.toContainText('Error:');
 await visualShot(page,`components-${width}`);visualSave(`components-${width}`,{text:await sample.innerText()});
});

test('visual1680 초점 키보드 최소 폭과 창 크기',async({page})=>{
 test.skip(visualPhase==='before','조작 계약은 변경 후 검수');
 await page.setViewportSize({width:360,height:844});const state=await fixture(page,18,seed(),12);
 const home=page.getByTestId('card-home');await home.getByRole('switch',{name:'완료·취소 숨김'}).uncheck();
 const search=home.getByRole('textbox',{name:'제목 또는 요청 검색'});await search.fill('완료');await expect(search).toHaveValue('완료');
 await search.focus();await page.keyboard.press('Tab');const tab=await page.evaluate(()=>({tag:document.activeElement?.tagName,visible:!!(document.activeElement as HTMLElement)?.getClientRects().length}));
 expect(tab.visible).toBe(true);expect(tab.tag).not.toBe('BODY');
 const narrow=await page.evaluate(()=>({width:document.documentElement.clientWidth,scrollWidth:document.documentElement.scrollWidth}));expect(narrow.scrollWidth).toBeLessThanOrEqual(narrow.width);
 const expand=home.getByRole('button',{name:'보드 확대',exact:true});await expand.click();
 const dialog=page.getByRole('dialog',{name:'전체 카드 보드'});await expect(dialog).toBeVisible();
 const openedFocus=await page.evaluate(()=>({inside:!!document.activeElement?.closest('[role=dialog]'),tag:document.activeElement?.tagName}));expect(openedFocus.inside).toBe(true);
 await page.keyboard.press('Escape');await expect(dialog).toHaveCount(0);await expect(expand).toBeFocused();
 const scroller=state.board.locator('[data-board-column="done"] [data-testid="virtuoso-scroller"]');await expect(scroller).toBeAttached();
 await scroller.evaluate(el=>{el.scrollTop=100;});const beforeScroll=await scroller.evaluate(el=>el.scrollTop);
 await page.setViewportSize({width:1440,height:900});await expect(search).toHaveValue('완료');
 const afterScroll=await scroller.evaluate(el=>el.scrollTop);expect(afterScroll).toBe(beforeScroll);
 await visualShot(page,'interaction-1440');visualSave('interaction',{tab,openedFocus,focusRestored:true,escapeClosed:true,narrow,beforeScroll,afterScroll,value:await search.inputValue()});
});

const longCompletedError='카드 요청 실패 (500): GET https://soulstream.example/api/cards?status=done&completedFrom=2026-11-11T21%3A42%3A03.038Z\n'+
 'TypeError: Failed to fetch dynamically imported module https://soulstream.example/assets/use-completed-cards-Bx7d9QeR2kLmNoPqRsTuVwXyZ.js\n'+
 Array.from({length:8},(_,i)=>`    at loadCompletedPage (https://soulstream.example/assets/index-${i}a8f3c2d1.js:${1200+i}:${17+i})`).join('\n');
async function measureLongError(page:Page,width:number,height:number,folder=false,verify=true,name?:string){
 await page.setViewportSize({width,height});await fixture(page,17,seed(),0,{fail:true,detail:longCompletedError});
 let surface=page.getByTestId('card-home');if(folder){await openCompletedFolder(page);surface=page.getByTestId('folder-card-section');}
 await surface.getByRole('switch',{name:'완료·취소 숨김'}).uncheck();
 const col=surface.locator('[data-board-column="done"]'),alert=col.getByRole('alert');await expect(alert).toBeVisible();
 await col.scrollIntoViewIfNeeded();await alert.getByText('기술 상세').click();await expect(alert.locator('pre')).toBeVisible();
 const data=await col.evaluate(c=>{const rect=(selector:string)=>{const r=c.querySelector(selector)!.getBoundingClientRect();return {top:r.top,bottom:r.bottom,height:r.height};};const pre=c.querySelector('pre')!;const viewport=c.querySelector('[data-testid="completed-viewport"]')!;
  return {viewport:rect('[data-testid="completed-viewport"]'),notice:rect('.v3-error-notice'),button:rect('.v3-error-notice-actions button'),pre:rect('pre'),preScroll:{height:pre.scrollHeight,client:pre.clientHeight},viewportOverflow:getComputedStyle(viewport).overflow};});
 if(name){await visualShot(page,name);visualSave(name,data);}
 if(verify){expect(data.notice.bottom).toBeLessThanOrEqual(data.viewport.bottom+1);expect(data.button.bottom).toBeLessThanOrEqual(data.viewport.bottom+1);expect(data.pre.bottom).toBeLessThanOrEqual(data.button.top+1);expect(data.preScroll.height).toBeGreaterThan(data.preScroll.client);expect(data.viewportOverflow).toBe('hidden');}
 return data;
}
async function measureFolderError(page:Page,width:number,verify=true,name?:string){
 await page.setViewportSize({width,height:width===390?844:900});await fixture(page,17,seed(),0,{folderFailure:true});await openCompletedFolder(page);
 const folder=page.getByTestId('folder-card-section'),alert=folder.getByRole('alert').first();await expect(alert).toBeVisible();await alert.scrollIntoViewIfNeeded();
 const board=await folder.evaluate(f=>{const notice=f.querySelector('.v3-error-notice')!.getBoundingClientRect(),head=f.querySelector('.v3-card-board-workspace > .v3-detail-section-head')!.getBoundingClientRect();return {noticeBottom:notice.bottom,headTop:head.top,gap:head.top-notice.bottom};});
 if(name)await visualShot(page,`${name}-board`);
 await folder.getByRole('button',{name:'일반 보기',exact:true}).click();await alert.scrollIntoViewIfNeeded();
 const list=await folder.evaluate(f=>{const notice=f.querySelector('.v3-error-notice')!.getBoundingClientRect(),head=f.querySelector(':scope > .v3-folder-card-head')!.getBoundingClientRect();return {noticeTop:notice.top,headBottom:head.bottom,gap:notice.top-head.bottom};});
 if(name){await visualShot(page,`${name}-list`);visualSave(name,{board,list});}
 if(verify){expect(board.gap).toBeGreaterThan(0);expect(Math.abs(board.gap-list.gap)).toBeLessThanOrEqual(1);}
 return {board,list};
}
for(const [width,height] of [[390,844],[1366,768]])test(`card1680 긴 오류 상세가 완료 열 안에 유지 ${width}`,async({page})=>{await measureLongError(page,width,height);});
test('card1680 폴더 오류와 머리 간격이 보기마다 같다',async({page})=>{await measureFolderError(page,390);});

for(const theme of ['light','dark'] as const){
 for(const width of [390,1440])test(`visual1680-review board-error-long ${theme} ${width}`,async({page})=>{await page.emulateMedia({colorScheme:theme,reducedMotion:'reduce'});await measureLongError(page,width,width===390?844:900,false,visualPhase==='review-after',`board-error-long-${theme}-${width}`);});
 test(`visual1680-review board-error-size ${theme}`,async({page})=>{await page.emulateMedia({colorScheme:theme,reducedMotion:'reduce'});await measureLongError(page,1366,768,false,visualPhase==='review-after',`board-error-size-${theme}-1366`);});
 test(`visual1680-review folder-board-long ${theme}`,async({page})=>{await page.emulateMedia({colorScheme:theme,reducedMotion:'reduce'});await measureLongError(page,390,844,true,visualPhase==='review-after',`folder-board-long-${theme}-390`);});
 for(const width of [390,1440])test(`visual1680-review folder-error-board ${theme} ${width}`,async({page})=>{await page.emulateMedia({colorScheme:theme,reducedMotion:'reduce'});await measureFolderError(page,width,visualPhase==='review-after',`folder-error-board-${theme}-${width}`);});
}

test('card1680 정상 폴더 진행 격자와 완료 묶음 간격',async({page})=>{
 for(const width of [390,1440]){
  await page.setViewportSize({width,height:width===390?844:900});await fixture(page);await openCompletedFolder(page);
  const folder=page.getByTestId('folder-card-section');await folder.getByRole('button',{name:'일반 보기',exact:true}).click();
  await folder.getByRole('switch',{name:'완료·취소 숨김'}).uncheck();
  const grid=folder.locator(':scope > .v3-postit-grid').first(),completed=folder.locator(':scope > .v3-completed-collection');
  await expect(completed).toBeVisible();
  const gap=await completed.evaluate(el=>el.getBoundingClientRect().top-el.previousElementSibling!.getBoundingClientRect().bottom);
  expect(Math.abs(gap)).toBeLessThanOrEqual(1);await expect(grid).toBeAttached();
  await page.unrouteAll({behavior:'wait'});
 }
});

type NormalCards='present'|'none'|'doneOnly';
for(const width of [390,1440])for(const mode of ['present','none','doneOnly'] as NormalCards[]){
 test(`visual1680-normal ${mode} ${width}`,async({page})=>{
  await page.emulateMedia({colorScheme:'light',reducedMotion:'reduce'});await page.setViewportSize({width,height:width===390?844:900});
  const cards=mode==='none'?[]:mode==='doneOnly'?seed().filter(card=>card.status==='done'):seed();
  await fixture(page,17,cards);await openCompletedFolder(page);
  const folder=page.getByTestId('folder-card-section');const result:Record<string,unknown>={};
  const snap=async(key:string)=>{
   await page.waitForTimeout(500);await expect(folder.getByText(/불러오는 중/)).toHaveCount(0,{timeout:15000});await page.waitForTimeout(300);await folder.scrollIntoViewIfNeeded();
   result[key]=await page.evaluate(()=>{const sec=document.querySelector('[data-testid="v3-folder-cards-section"]')!,fc=sec.querySelector('[data-testid="folder-card-section"]')!,top=sec.getBoundingClientRect().top;
    const rect=(el:Element)=>{const r=el.getBoundingClientRect();return {top:Math.round((r.top-top)*10)/10,bottom:Math.round((r.bottom-top)*10)/10,height:Math.round(r.height*10)/10,left:Math.round(r.left*10)/10,right:Math.round(r.right*10)/10};};
    const name=(el:Element)=>`${el.tagName.toLowerCase()}.${el.className.toString().trim().split(/\s+/).filter(c=>c.startsWith('v3-')).slice(0,2).join('.')}`;
    return {section:rect(sec),container:rect(fc),children:[...fc.children].map(el=>({name:name(el),...rect(el)}))};});
   if(key==='list-on')await folder.locator(':scope > .v3-completed-collection').evaluate(el=>{
    el.scrollIntoView({block:'start',inline:'nearest'});
    const scroll=el.closest<HTMLElement>('.v3-planner-scroll');if(scroll)scroll.scrollTop-=scroll.clientHeight/2;
   });
   await visualShot(page,`normal-${mode}-${width}-${key}`);
  };
  await snap('board-off');await folder.getByRole('switch',{name:'완료·취소 숨김'}).uncheck();await snap('board-on');
  await folder.getByRole('button',{name:'일반 보기',exact:true}).click();await snap('list-on');
  await folder.getByRole('switch',{name:'완료·취소 숨김'}).check();await snap('list-off');visualSave(`normal-${mode}-${width}`,result);
 });
}
