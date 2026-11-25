import type { Browser, Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { runPlaywrightLifecycle } from "./playwright-lifecycle-harness.mjs";
import { installV3VisualQaRoutes } from "./v3-visual-fixtures";
import { reviewCard } from "../client/v3/components-review-fixtures";

const output = path.resolve(process.env.QA_SHOT_DIR ?? ".local/card-dependencies-shots");
const base = process.env.V3_QA_BASE_URL ?? "http://127.0.0.1:4173";
const HELP_TEXT = "선행 카드가 끝나면 실행 상한과 대기 순서와 상관없이 서버가 그 카드를 바로 시작한다. 중앙 카드 배정이 켜져 있으면 쓰이지 않는다.";
const PAPER_COLORS = ["yellow", "pink", "mint", "blue", "lavender"] as const;
const dep = (number: number, extra = {}) => ({id:`dep-${number}`,number,title:`선행 카드 ${number}`,status:"running" as const,archived:false,met:false,...extra});
const longDep = (number: number, title: string, extra = {}) => ({...dep(number, extra), title});
const queued = (id: string, number: number, title: string, dependsOn: unknown[], extra = {}) =>
 ({...reviewCard,id,number,folderId:"folder-amber",status:"queued" as const,title,dependsOn,...extra}) as typeof reviewCard;

// 보드 장면: 가장 긴 제목, 선행 1장, 2장, 3장 이상, 취소, 보관, 충족된 선행이 섞인 경우
const boardCards = [
 ["한 장",[dep(12)]], ["두 장",[dep(12),dep(15)]], ["세 장",[dep(12),dep(15),dep(16)]],
 ["취소",[dep(17,{status:"cancelled"})]], ["보관",[dep(18,{archived:true})]], ["충족 섞임",[dep(19,{status:"done",met:true}),dep(20)]],
].map(([title,dependsOn],index)=>queued(`deps-${index}`,100+index,`${title} ${"긴 카드 제목 ".repeat(6)}`,dependsOn as unknown[]));
// 상세와 확인 창 장면: 충족, 긴 제목 실행 중, 취소, 충족되지 않은 채 보관된 선행이 함께 있는 카드
const detailCard = queued("deps-detail",1865,"카드 의존 관계 웹과 앱 보기 화면 구현",[
 longDep(1863,"card_dependencies 테이블 마이그레이션과 wire-schema 문구 계약 정리",{status:"done",met:true}),
 longDep(1864,"아주 긴 한국어 선행 카드 제목이 360폭에서 자연스럽게 말줄임되는지 확인하는 서버 핵심 구현"),
 longDep(1861,"외부 대기열 감시 워커 임시 배포",{status:"cancelled"}),
 longDep(1860,"미완료 상태로 보관된 구버전 마이그레이션 작업",{status:"queued",archived:true}),
],{color:"yellow"});
// 오류 스트립 대비: 모든 종이 색 위에 취소된 선행을 둔다
const inkCards = PAPER_COLORS.map((color,index)=>queued(`deps-ink-${color}`,300+index,`종이 ${color} 선행 취소`,[dep(1861,{status:"cancelled"})],{color}));
const cards = [...boardCards, detailCard, ...inkCards];
// PAS 작업 목록 장면: 짧은 대기, 짧은 취소, 긴 제목 취소, 긴 제목 보관
const pasCards = [
 queued("pas-wait-short",1866,"짧은 대기 카드",[longDep(1864,"서버 핵심 구현")],{color:"blue"}),
 queued("pas-cancelled-short",1867,"짧은 취소 카드",[longDep(1861,"외부 대기열 감시 워커 임시 배포",{status:"cancelled"})],{color:"pink"}),
 queued("pas-cancelled-long",1868,"구버전 대기열 제목 괄호 감시 스크립트 정리와 회귀 테스트 보강 작업",[longDep(1861,"외부 대기열 감시 워커 임시 배포",{status:"cancelled"})],{color:"yellow"}),
 queued("pas-archived-long",1869,"보관된 선행을 기다리는 아주 긴 제목의 대기 작업 카드",[longDep(1860,"보관된 선행",{status:"queued",archived:true})],{color:"mint"}),
];
mkdirSync(output,{recursive:true});
const browserCache=path.join(homedir(),".cache/ms-playwright");
const fallback=existsSync(browserCache)?readdirSync(browserCache).filter(name=>name.startsWith("chromium_headless_shell-")).sort().reverse().map(name=>path.join(browserCache,name,"chrome-headless-shell-linux64/chrome-headless-shell")).find(existsSync):undefined;
const configured=process.env.QA_CHROMIUM_EXECUTABLE??process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
const measurements:unknown[]=[];
for(const width of [1280,360]) for(const theme of ["light","dark"] as const)
 await runPlaywrightLifecycle({lockName:"card-dependencies-qa",timeoutMs:420_000,launchOptions:{headless:true,executablePath:configured&&existsSync(configured)?configured:fallback}},async({browser})=>verify(browser,width,theme,measurements));
writeFileSync(path.join(output,"metrics.json"),JSON.stringify(measurements,null,2));
console.log(JSON.stringify(measurements,null,2));

async function openPage(browser:Browser,width:number,theme:"light"|"dark",postitCards:typeof cards) {
 const context=await browser.newContext({viewport:{width,height:900},colorScheme:theme,reducedMotion:"reduce"});
 const page=await context.newPage();
 page.setDefaultTimeout(60_000);
 // 서비스 워커가 로드 뒤 페이지를 다시 불러오므로 등록을 막는다. tsx가 함수에 붙이는 __name 보조 함수가 페이지에 없으니 문자열로 넘기고 빈 함수로 채운다.
 await page.addInitScript(`window.__name=(f)=>f;localStorage.setItem("soul-dashboard-theme",${JSON.stringify(theme)});localStorage.setItem("ls.webglGlass","0");Object.defineProperty(navigator.serviceWorker,"register",{configurable:true,value:async()=>({update:async()=>undefined,active:null,addEventListener:()=>undefined})});Object.defineProperty(navigator.serviceWorker,"controller",{configurable:true,get:()=>null});`);
 await installV3VisualQaRoutes(page,{unifiedFolderView:true,postitCards});
 return {context,page};
}

async function verify(browser:Browser,width:number,theme:"light"|"dark",measurements:unknown[]) {
 const result:Record<string,unknown>={width,theme};
 {
  const {context,page}=await openPage(browser,width,theme,cards);
  let failDetail=false;
  const mutations:string[]=[];
  page.on("request",request=>{if(request.method()!=="GET"&&/\/api\/cards\//.test(request.url()))mutations.push(`${request.method()} ${new URL(request.url()).pathname}`);});
  const cardJson=(url:string)=>({card:cards.find(card=>url.includes(`/api/cards/${card.id}`)),reports:[],questions:[],sessions:[]});
  await page.route("**/api/cards/deps-*/**",route=>route.fulfill({status:200,json:cardJson(route.request().url())}));
  await page.route("**/api/cards/deps-*",route=>failDetail?route.fulfill({status:503,json:{message:"읽기 실패"}}):route.fulfill({status:200,json:cardJson(route.request().url())}));
  await page.goto(`${base}/v3`);const home=page.getByTestId("card-home");await home.waitFor();
  await page.locator('[data-card-id="deps-0"]').waitFor();
  await shot(page,`board-${width}-${theme}.png`);
  await page.locator('[data-card-id="deps-0"] .v3-postit-turn').waitFor();
  const text=await page.locator('[data-card-id="deps-0"] .v3-postit-turn').innerText();
  if(!text.includes("선행 대기 #12"))throw new Error(`대기 문구 누락: ${text}`);
  const stopped=await page.locator('[data-card-id="deps-3"] .v3-postit-turn').innerText();
  if(!stopped.includes("선행 취소됨 #17"))throw new Error(`취소 문구 누락: ${stopped}`);
  for(const [index,expected] of [[1,"선행 대기 #12, #15"],[2,"선행 대기 #12 외 2건"],[4,"선행 보관됨 #18"],[5,"선행 대기 #20"]] as const) {
   const actual=await page.locator(`[data-card-id="deps-${index}"] .v3-postit-turn`).innerText();
   if(!actual.includes(expected))throw new Error(`선행 문구 누락: ${actual}`);
  }
  // 오류 스트립 글자 대비: 두 테마와 모든 종이 색에서 4.5:1 이상
  const contrast=await page.evaluate(measureStripContrast);
  const errorStrips=contrast.filter(item=>item.tone==="error");
  const missingColors=PAPER_COLORS.filter(color=>!errorStrips.some(item=>item.paper===color));
  if(missingColors.length)throw new Error(`종이 색 ${missingColors.join(", ")}에 오류 스트립이 없다`);
  const lowContrast=contrast.filter(item=>item.ratio<4.5);
  if(lowContrast.length)throw new Error(`스트립 글자 대비 4.5 미만: ${JSON.stringify(lowContrast)}`);
  result.stripContrast=contrast.map(item=>({paper:item.paper,tone:item.tone,ratio:Number(item.ratio.toFixed(2))}));
  // 대조군: 고치기 전 색(var(--v3-error) 그대로)을 걸면 같은 측정이 4.5 미만을 잡아야 한다
  const oldRule=(await page.evaluate(measureStripContrast,"var(--v3-error)")).filter(item=>item.tone==="error");
  if(oldRule.some(item=>item.ratio>=4.5))throw new Error(`대조군이 옛 색의 낮은 대비를 잡지 못한다: ${JSON.stringify(oldRule.map(item=>item.ratio))}`);
  result.stripContrastOldRule=oldRule.map(item=>({paper:item.paper,ratio:Number(item.ratio.toFixed(2))}));
  await page.locator('[data-card-id="deps-3"]').scrollIntoViewIfNeeded();
  await shot(page,`stopped-${width}-${theme}.png`);

  // 상세: 충족, 긴 제목, 취소, 보관된 선행이 한 카드에 있다
  await page.locator('[data-card-id="deps-detail"]').scrollIntoViewIfNeeded();
  await page.locator('[data-card-id="deps-detail"] .v3-postit-open').click();
  const detail=page.getByTestId("card-detail");await detail.waitFor();
  const rows=detail.locator(".v3-card-dependency-row");await rows.first().waitFor();
  if(await rows.count()!==4)throw new Error(`상세 선행 줄이 4개가 아니다: ${await rows.count()}`);
  if(!(await detail.locator(".v3-card-dependencies .v3-detail-section-head").innerText()).replace(/\s+/g,"").includes("선행카드1/4"))throw new Error("선행 카드 충족 수가 1/4가 아니다");
  await shot(page,`detail-${width}-${theme}.png`);
  const rowReport=await measureDependencyRows(detail);
  result.detailRows=rowReport;
  const chipOf=(number:number)=>rowReport.find(row=>row.number===`#${number}`)!;
  if(!chipOf(1864).truncated||chipOf(1864).textOverflow!=="ellipsis")throw new Error(`긴 선행 제목이 말줄임되지 않는다: ${JSON.stringify(chipOf(1864))}`);
  if(chipOf(1860).chip!=="보관됨"||!chipOf(1860).chipClass.includes("v3-status-chip--error")||!chipOf(1860).stopped)throw new Error(`보관 선행 칩이 보관됨(오류 톤)이 아니다: ${JSON.stringify(chipOf(1860))}`);
  if(chipOf(1861).chip!=="취소"||!chipOf(1861).stopped)throw new Error(`취소 선행 칩이 취소가 아니다: ${JSON.stringify(chipOf(1861))}`);
  if(chipOf(1864).chip!=="실행 중"||chipOf(1864).stopped||chipOf(1863).chip!=="완료"||chipOf(1863).stopped)throw new Error("진행 중과 충족 선행 칩이 어긋난다");
  assertRowsFit(rowReport);

  // 상태 메뉴에서 실행 중을 고르면 확인 창이 뜬다
  await detail.getByRole("button",{name:"카드 상태 변경"}).click();
  await page.locator("[data-card-status-picker]").getByRole("button",{name:"실행 중",exact:true}).click();
  const dialog=page.getByRole("alertdialog");await dialog.waitFor();
  await page.waitForTimeout(500);
  if(await page.locator("[data-card-status-picker]").isVisible())throw new Error("상태 메뉴가 확인 창을 가립니다");
  const firstFocus=await page.evaluate(()=>document.activeElement?.textContent);
  await shot(page,`confirm-${width}-${theme}.png`);
  const confirmText=await dialog.locator('[data-slot="alert-dialog-description"]').innerText();
  for(const expected of ["#1864(실행 중)","#1861(취소)","#1860(보관됨)"])if(!confirmText.includes(expected))throw new Error(`확인 창에 ${expected}가 없다: ${confirmText}`);
  if(confirmText.includes("#1860(대기)")||confirmText.includes("#1863"))throw new Error(`확인 창 목록이 어긋난다: ${confirmText}`);
  const wrap=await measureConfirmWrap(page);
  result.confirmWrap=wrap;
  if(wrap.wordBreak!=="keep-all"||wrap.overflowWrap!=="anywhere")throw new Error(`확인 창 줄바꿈 속성: ${JSON.stringify(wrap)}`);
  if(wrap.brokenWords.length)throw new Error(`확인 창이 어절 중간에서 줄을 바꾼다: ${JSON.stringify(wrap)}`);
  if(wrap.scrollWidth>wrap.clientWidth)throw new Error(`확인 창 본문이 넘친다: ${JSON.stringify(wrap)}`);
  if(width===360) {
   // 대조군: 수정 전에 「기|다리지」로 끊기던 문장을 같은 폭의 복제 노드에 넣는다. 속성을 풀면 끊기고 지키면 안 끊겨야 이 측정이 믿을 만하다
   const loose=await measureConfirmWrap(page,{loose:true}),strict=await measureConfirmWrap(page,{loose:false});
   if(!loose.brokenWords.length)throw new Error("대조군에서 어절 중간 줄바꿈이 잡히지 않아 측정을 믿을 수 없다");
   if(strict.brokenWords.length)throw new Error(`대조 문장도 어절 중간에서 끊긴다: ${JSON.stringify(strict)}`);
   result.confirmWrapControl={loose:loose.brokenWords,strict:strict.brokenWords};
  }
  await page.keyboard.press("Tab");const tabFocus=await page.evaluate(()=>document.activeElement?.textContent);
  await page.keyboard.press("Escape");await dialog.waitFor({state:"hidden"});
  const afterEscape=await page.evaluate(()=>document.activeElement?.getAttribute("aria-label"));

  // 카드 조회 실패와 다시 불러오기
  failDetail=true;await detail.getByRole("button",{name:"카드 상태 변경"}).click();
  const picker=page.locator("[data-card-status-picker]");await picker.getByRole("alert").waitFor();
  await shot(page,`error-${width}-${theme}.png`);
  failDetail=false;await picker.getByRole("button",{name:"다시 불러오기"}).click();
  await picker.getByRole("button",{name:"실행 중",exact:true}).waitFor({state:"visible"});
  await page.keyboard.press("Escape");

  // 상세의 ▶ 단추: 기본 초점이 취소이므로 Enter는 실행하지 않고 닫는다. 지금 시작에서 Enter를 누르면 실행한다
  const play=detail.getByRole("button",{name:"시작하기",exact:true});
  mutations.length=0;
  await play.click();await dialog.waitFor();await page.waitForTimeout(200);
  const enterFocus=await page.evaluate(()=>document.activeElement?.textContent);
  if(enterFocus!=="취소")throw new Error(`확인 창 기본 초점이 취소가 아니다: ${enterFocus}`);
  await page.keyboard.press("Enter");await dialog.waitFor({state:"hidden"});await page.waitForTimeout(300);
  const mutationsAfterCancelEnter=mutations.length;
  if(mutationsAfterCancelEnter)throw new Error(`취소에서 Enter를 눌렀는데 변경 요청이 나갔다: ${mutations.join(", ")}`);
  await play.click();await dialog.waitFor();await page.waitForTimeout(200);
  await page.keyboard.press("Tab");
  const startFocus=await page.evaluate(()=>document.activeElement?.textContent);
  if(startFocus!=="지금 시작")throw new Error(`Tab 뒤 초점이 지금 시작이 아니다: ${startFocus}`);
  await page.keyboard.press("Enter");await dialog.waitFor({state:"hidden"});
  for(let waited=0;!mutations.length&&waited<3_000;waited+=100)await page.waitForTimeout(100);
  const mutationsAfterStartEnter=mutations.length;
  if(!mutationsAfterStartEnter)throw new Error("지금 시작에서 Enter를 눌렀는데 변경 요청이 나가지 않았다");
  result.enter={focusOnOpen:enterFocus,mutationsAfterCancelEnter,tabFocus:startFocus,mutationsAfterStartEnter};

  // 창 크기를 바꿔도 선행 줄이 화면 안에 있다
  const resizedWidth=width===360?1280:360;
  await page.setViewportSize({width:resizedWidth,height:900});
  await page.waitForFunction(target=>document.documentElement.clientWidth===target&&document.documentElement.scrollWidth<=target,resizedWidth,{timeout:5_000}).catch(()=>undefined);
  const resized=await page.evaluate(()=>({clientWidth:document.documentElement.clientWidth,scrollWidth:document.documentElement.scrollWidth}));
  if(resized.scrollWidth>resized.clientWidth)throw new Error(`창 크기 변경 뒤 가로 넘침: ${JSON.stringify(resized)}`);
  if(await detail.isVisible().catch(()=>false)) {
   const resizedRows=await measureDependencyRows(detail);
   if(resizedRows.length)assertRowsFit(resizedRows);
   result.resizedRows=resizedRows.length;
  }

  // 설정 탭: 라벨을 눌러도 스위치가 바뀌고 글자 크기가 다른 설정 라벨과 같다
  await page.setViewportSize({width,height:900});await page.goto(`${base}/components`);
  const sample=page.getByTestId("card-dependency-samples");await sample.waitFor();
  const reviewSwitch=sample.getByRole("switch",{name:"검수 대기도 끝난 것으로 친다"});await reviewSwitch.scrollIntoViewIfNeeded();
  const releasedSwitch=sample.getByRole("switch",{name:"풀린 카드를 바로 시작한다"});await releasedSwitch.waitFor();
  await shot(page,`settings-${width}-${theme}.png`);
  const settings=await sample.evaluate(root=>{
   const label=(text:string)=>[...root.querySelectorAll<HTMLElement>("label span")].find(span=>span.textContent===text);
   const size=(el:HTMLElement|undefined)=>el?getComputedStyle(el).fontSize:null;
   const helpEl=[...root.querySelectorAll<HTMLElement>("label span")].find(span=>span.textContent?.startsWith("선행 카드가 끝나면"));
   return {
    base:size(label("기본값")),review:size(label("검수 대기도 끝난 것으로 친다")),released:size(label("풀린 카드를 바로 시작한다")),help:size(helpEl),helpText:helpEl?.textContent??null,
    wrapped:["검수 대기도 끝난 것으로 친다","풀린 카드를 바로 시작한다"].map(name=>{const sw=root.querySelector(`[role="switch"][aria-label="${name}"]`);return Boolean(sw?.closest("label")?.contains(label(name)??null));}),
   };
  });
  result.settings=settings;
  if(!settings.base||settings.review!==settings.base||settings.released!==settings.base||settings.help!==settings.base)throw new Error(`설정 라벨 글자 크기가 다르다: ${JSON.stringify(settings)}`);
  if(settings.helpText!==HELP_TEXT)throw new Error(`보조 문구가 기준본과 다르다: ${settings.helpText}`);
  if(settings.wrapped.some(ok=>!ok))throw new Error(`스위치와 라벨 글자가 같은 label 안에 없다: ${JSON.stringify(settings)}`);
  for(const name of ["검수 대기도 끝난 것으로 친다","풀린 카드를 바로 시작한다"]) {
   const toggle=sample.getByRole("switch",{name});
   const before=await toggle.getAttribute("aria-checked");
   await sample.locator("label span",{hasText:new RegExp(`^${name}$`)}).click();
   const after=await toggle.getAttribute("aria-checked");
   if(before===after)throw new Error(`${name} 라벨 글자를 눌러도 스위치가 바뀌지 않는다(${before})`);
  }
  await reviewSwitch.click();await sample.getByRole("button",{name:"저장",exact:true}).click();
  await sample.getByRole("status").filter({hasText:"저장했습니다"}).waitFor();
  Object.assign(result,{firstFocus,tabFocus,afterEscape,resized,document:await page.evaluate(()=>({clientWidth:document.documentElement.clientWidth,scrollWidth:document.documentElement.scrollWidth}))});
  await context.close();
 }
 result.pas=await verifyPasList(browser,width,theme);
 measurements.push(result);
 writeFileSync(path.join(output,"metrics.json"),JSON.stringify(measurements,null,2));
}

// PAS 작업 목록: 긴 제목에서도 경고 표식이 온전히 보이고 이웃 글자와 떨어져 있다
async function verifyPasList(browser:Browser,width:number,theme:"light"|"dark") {
 const {context,page}=await openPage(browser,width,theme,pasCards as typeof cards);
 await page.route("**/api/auth/status",route=>route.fulfill({status:200,json:{authenticated:true,user:{email:"qa@example.com",name:"QA",isAdmin:true}}}));
 const settings={default_model:{model_preset:null,reasoning_effort:null},fallback_models:[],show_generation_separator:true,show_character:false,animate_character:false,show_jev_candidates:true,turn_usage_mode:"collapsed",show_turn_usage:true};
 const session={session_id:"run-alpha-2",display_name:"서소영 (PAS)",node_id:"eiaserinnys",folder_id:"rb-alpha",agent_id:"roselin_codex",agent_name:"서소영",persistent:true,settings,runtime:{current_model:{model_preset:null,reasoning_effort:null,model:null},pending:null}};
 await page.route("**/api/persistent-sessions**",route=>{
  const url=new URL(route.request().url());
  if(url.pathname==="/api/persistent-sessions")return route.fulfill({status:200,json:{sessions:[session],total:1,create_defaults:{node_id:"eiaserinnys",preferred_agent_id:"seosoyoung",settings:{...settings,show_character:true,animate_character:true},initial_instruction:"검수용 영구 세션",unavailable_reason:null}}});
  if(url.pathname==="/api/persistent-sessions/run-alpha-2")return route.fulfill({status:200,json:{session}});
  return route.fallback();
 });
 await page.goto(`${base}/persistent/run-alpha-2`);
 const openTasks=page.getByRole("button",{name:"작업 목록",exact:true});
 await openTasks.waitFor({state:"visible",timeout:8_000}).catch(()=>undefined);
 if(await openTasks.isVisible().catch(()=>false))await openTasks.click();
 const taskList=page.locator(".v3-persistent-task-list");await taskList.waitFor({state:"visible"});
 const queuedToggle=taskList.locator(".v3-persistent-task-group-toggle").filter({hasText:"대기"}).first();
 if(await queuedToggle.count()&&await queuedToggle.getAttribute("aria-expanded")==="false"){await queuedToggle.click();await page.waitForTimeout(200);}
 await taskList.locator('[data-card-id="pas-archived-long"]').scrollIntoViewIfNeeded();
 await shot(page,`pas-list-${width}-${theme}.png`);
 const rows=await taskList.evaluate(root=>{
  const probe=document.createElement("span");probe.style.cssText="position:absolute;visibility:hidden;width:var(--v3-space-1)";root.append(probe);
  const gap=probe.getBoundingClientRect().width;probe.remove();
  if(!gap)throw new Error("--v3-space-1을 읽지 못했다");
  return {gap,rows:[...root.querySelectorAll<HTMLElement>(".v3-card-summary-row")].map(row=>{
   const title=row.querySelector<HTMLElement>(".v3-card-summary-title");
   const icon=row.querySelector<SVGElement>("svg[aria-label]");
   const avatar=row.querySelector<HTMLElement>(".v3-card-summary-avatar");
   const rowRect=row.getBoundingClientRect(),titleRect=title?.getBoundingClientRect(),iconRect=icon?.getBoundingClientRect(),avatarRect=avatar?.getBoundingClientRect();
   const hit=iconRect?document.elementFromPoint(iconRect.left+iconRect.width/2,iconRect.top+iconRect.height/2):null;
   return {
    cardId:row.dataset.cardId??"",label:icon?.getAttribute("aria-label")??null,truncated:Boolean(title&&title.scrollWidth>title.clientWidth),
    insideTitle:Boolean(title&&icon&&title.contains(icon)),
    iconWidth:iconRect?iconRect.width:0,visible:Boolean(icon&&hit&&(hit===icon||icon.contains(hit))),
    gapFromTitle:titleRect&&iconRect?iconRect.left-titleRect.right:null,
    gapToAvatar:avatarRect&&iconRect?avatarRect.left-iconRect.right:null,
    insideRow:iconRect?iconRect.left>=rowRect.left&&iconRect.right<=rowRect.right:null,
   };
  })};
 });
 const byId=(id:string)=>rows.rows.find(row=>row.cardId===id);
 const expectations:Array<[string,string|null,boolean]>=[["pas-wait-short",null,false],["pas-cancelled-short","선행 취소됨 #1861",false],["pas-cancelled-long","선행 취소됨 #1861",true],["pas-archived-long","선행 보관됨 #1860",true]];
 for(const [id,label,truncated] of expectations) {
  const row=byId(id);if(!row)throw new Error(`PAS 목록에 ${id} 행이 없다`);
  if(row.label!==label)throw new Error(`${id} 경고 표식 문구: ${row.label}`);
  if(!label)continue;
  if(truncated&&!row.truncated)throw new Error(`${id} 제목이 말줄임되지 않아 측정이 의미 없다: ${JSON.stringify(row)}`);
  if(row.insideTitle||!row.visible||!row.insideRow||row.iconWidth<=0)throw new Error(`${id} 경고 표식이 잘리거나 가려진다: ${JSON.stringify(row)}`);
  if(row.gapFromTitle===null||row.gapFromTitle<rows.gap-0.5)throw new Error(`${id} 경고 표식이 제목과 붙어 있다(${row.gapFromTitle}px, 기준 ${rows.gap}px)`);
  if(row.gapToAvatar!==null&&row.gapToAvatar<rows.gap-0.5)throw new Error(`${id} 경고 표식이 아바타와 붙어 있다(${row.gapToAvatar}px)`);
 }
 // 툴팁은 마우스가 있는 768px 이상 화면에서만 뜬다(PersistentSessionTaskList의 TOOLTIP_MEDIA_QUERY)
 let tooltipText:string|null=null;
 if(width>=768) {
  const longRow=taskList.locator('[data-card-id="pas-cancelled-long"]');await longRow.scrollIntoViewIfNeeded();await longRow.hover();
  const tooltip=page.locator(".v3-persistent-task-tooltip");await tooltip.waitFor({state:"visible"});
  tooltipText=await tooltip.innerText();
  if(!tooltipText.includes("선행 취소됨 #1861"))throw new Error(`툴팁에 선행 문구가 없다: ${tooltipText}`);
  await shot(page,`pas-tooltip-${width}-${theme}.png`);
 }
 await context.close();
 return {gap:rows.gap,rows:rows.rows,tooltipText};
}

function assertRowsFit(rows:Awaited<ReturnType<typeof measureDependencyRows>>) {
 for(const row of rows)
  if(row.titleLeft<row.numberRight||row.titleRight>row.chipLeft||row.chipRight>row.rowRight||row.titleWidth<20||(row.truncated&&row.textOverflow!=="ellipsis")||row.documentOverflow)
   throw new Error(`선행 줄이 잘리거나 겹친다: ${JSON.stringify(row)}`);
}

async function measureDependencyRows(detail:ReturnType<Page["getByTestId"]>) {
 return detail.evaluate(root=>[...root.querySelectorAll<HTMLElement>(".v3-card-dependency-row")].map(row=>{
  const title=row.querySelector<HTMLElement>(".v3-card-dependency-title")!,number=row.querySelector<HTMLElement>(".v3-card-dependency-number")!,chip=row.querySelector<HTMLElement>('[data-slot="status-chip"]')!;
  const r=row.getBoundingClientRect(),t=title.getBoundingClientRect(),n=number.getBoundingClientRect(),c=chip.getBoundingClientRect();
  return {
   number:number.textContent??"",chip:chip.textContent?.trim()??"",chipClass:chip.className,stopped:row.hasAttribute("data-stopped"),
   rowLeft:r.left,rowRight:r.right,numberRight:n.right,titleLeft:t.left,titleRight:t.right,titleWidth:t.width,chipLeft:c.left,chipRight:c.right,
   truncated:title.scrollWidth>title.clientWidth,textOverflow:getComputedStyle(title).textOverflow,
   documentOverflow:document.documentElement.scrollWidth>document.documentElement.clientWidth,
  };
 }));
}

// 확인 창 본문의 어절이 줄 중간에서 끊기는지 잰다. control을 주면 본문 대신 대조 문장을 담은 복제 노드를 잰다(loose면 줄바꿈 속성을 푼다).
async function measureConfirmWrap(page:Page,control?:{loose:boolean}) {
 return page.evaluate(options=>{
  const real=document.querySelector<HTMLElement>('[role="alertdialog"] [data-slot="alert-dialog-description"]')!;
  let description=real;
  if(options) {
   description=real.cloneNode(false) as HTMLElement;description.removeAttribute("id");description.textContent="#12(실행 중)이 아직 충족되지 않았습니다. 기다리지 않고 지금 시작할까요?";
   real.after(description);
   if(options.loose){description.style.wordBreak="normal";description.style.overflowWrap="normal";}
  }
  const style=getComputedStyle(description);
  const lineHeight=parseFloat(style.lineHeight)||parseFloat(style.fontSize)*1.5;
  const brokenWords:string[]=[];
  const walker=document.createTreeWalker(description,NodeFilter.SHOW_TEXT);
  for(let node=walker.nextNode();node;node=walker.nextNode()) {
   for(const match of (node.textContent??"").matchAll(/\S+/g)) {
    const range=document.createRange();range.setStart(node,match.index??0);range.setEnd(node,(match.index??0)+match[0].length);
    const tops=[...range.getClientRects()].map(rect=>rect.top);
    if(tops.length>1&&Math.max(...tops)-Math.min(...tops)>lineHeight/2)brokenWords.push(match[0]);
   }
  }
  const report={wordBreak:style.wordBreak,overflowWrap:style.overflowWrap,brokenWords,scrollWidth:description.scrollWidth,clientWidth:description.clientWidth,height:Math.round(description.getBoundingClientRect().height)};
  if(options)description.remove();
  return report;
 },control);
}

// 페이지 안에서 스트립 글자와 바탕의 대비를 잰다. 바탕은 가장 가까운 불투명 조상 위에 반투명 층을 차례로 칠해 얻는다.
function measureStripContrast(overrideColor?:string) {
 const canvas=document.createElement("canvas");canvas.width=1;canvas.height=1;
 const ctx=canvas.getContext("2d",{willReadFrequently:true})!;
 const paint=(css:string)=>{
  ctx.fillStyle="rgb(1, 2, 3)";
  ctx.fillStyle=css;
  if(ctx.fillStyle==="#010203"&&css!=="rgb(1, 2, 3)")throw new Error(`캔버스가 색을 읽지 못한다: ${css}`);
  ctx.fillRect(0,0,1,1);
 };
 const alphaOf=(css:string)=>{ctx.clearRect(0,0,1,1);paint(css);return ctx.getImageData(0,0,1,1).data[3]!;};
 const luminance=(rgb:ArrayLike<number>)=>{const [r,g,b]=[0,1,2].map(i=>{const v=rgb[i]!/255;return v<=0.03928?v/12.92:((v+0.055)/1.055)**2.4;});return 0.2126*r!+0.7152*g!+0.0722*b!;};
 return [...document.querySelectorAll<HTMLElement>(".v3-postit-turn[data-dependency-tone]")].map(strip=>{
  const layers:string[]=[];
  for(let el:HTMLElement|null=strip;el;el=el.parentElement) {
   const style=getComputedStyle(el);
   if(style.backgroundImage!=="none"&&el.classList.contains("v3-postit-card"))throw new Error("종이 바탕이 단색이 아니다");
   layers.push(style.backgroundColor);
   if(alphaOf(style.backgroundColor)===255)break;
  }
  ctx.clearRect(0,0,1,1);
  for(const layer of layers.reverse())paint(layer);
  const background=[...ctx.getImageData(0,0,1,1).data];
  // 글자색은 스트립에 걸리고 안쪽 글자가 물려받는다. 색 전환이 시작값을 돌려주지 않게 전환을 끄고 잰다.
  if(overrideColor){strip.style.transition="none";strip.style.color=overrideColor;}
  const textColor=getComputedStyle(strip).color;
  if(overrideColor){strip.style.removeProperty("color");strip.style.removeProperty("transition");}
  ctx.clearRect(0,0,1,1);paint(textColor);
  const text=[...ctx.getImageData(0,0,1,1).data];
  const [light,dark]=[luminance(background),luminance(text)].sort((a,b)=>b-a);
  return {tone:strip.dataset.dependencyTone??"",paper:strip.closest<HTMLElement>("[data-card-color]")?.dataset.cardColor??"",ratio:(light!+0.05)/(dark!+0.05),text,background};
 });
}

async function shot(page:Page,name:string) {
 await page.screenshot({path:path.join(output,name),animations:"disabled"});
}
