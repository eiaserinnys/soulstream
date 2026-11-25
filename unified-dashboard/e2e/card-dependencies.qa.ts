import type { Browser, Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { runPlaywrightLifecycle } from "./playwright-lifecycle-harness.mjs";
import { installV3VisualQaRoutes } from "./v3-visual-fixtures";
import { reviewCard } from "../client/v3/components-review-fixtures";

const output = path.resolve(process.env.QA_SHOT_DIR ?? ".local/card-dependencies-shots");
const base = process.env.V3_QA_BASE_URL ?? "http://127.0.0.1:4173";
const dep = (number: number, extra = {}) => ({id:`dep-${number}`,number,title:`선행 카드 ${number}`,status:"running" as const,archived:false,met:false,...extra});
const cards = [
 ["한 장",[dep(12)]], ["두 장",[dep(12),dep(15)]], ["세 장",[dep(12),dep(15),dep(16)]],
 ["취소",[dep(17,{status:"cancelled"})]], ["보관",[dep(18,{archived:true})]], ["충족 섞임",[dep(19,{status:"done",met:true}),dep(20)]],
].map(([title,dependsOn],index)=>({...reviewCard,id:`deps-${index}`,number:100+index,folderId:"folder-amber",status:"queued" as const,title:`${title} ${"긴 카드 제목 ".repeat(6)}`,dependsOn}));
mkdirSync(output,{recursive:true});
const browserCache=path.join(homedir(),".cache/ms-playwright");
const fallback=existsSync(browserCache)?readdirSync(browserCache).filter(name=>name.startsWith("chromium_headless_shell-")).sort().reverse().map(name=>path.join(browserCache,name,"chrome-headless-shell-linux64/chrome-headless-shell")).find(existsSync):undefined;
const configured=process.env.QA_CHROMIUM_EXECUTABLE??process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
const measurements:unknown[]=[];
for(const width of [1280,360]) for(const theme of ["light","dark"] as const)
 await runPlaywrightLifecycle({lockName:"card-dependencies-qa",timeoutMs:300_000,launchOptions:{headless:true,executablePath:configured&&existsSync(configured)?configured:fallback}},async({browser})=>verify(browser,width,theme,measurements));
writeFileSync(path.join(output,"metrics.json"),JSON.stringify(measurements,null,2));
console.log(JSON.stringify(measurements,null,2));

async function verify(browser:Browser,width:number,theme:"light"|"dark",measurements:unknown[]) {
 {
  const context=await browser.newContext({viewport:{width,height:900},colorScheme:theme,reducedMotion:"reduce"});
  const page=await context.newPage();
  page.setDefaultTimeout(60_000);
  // 서비스 워커가 로드 뒤 페이지를 다시 불러오므로 등록을 막는다. tsx가 함수에 붙이는 __name 보조 함수가 페이지에 없으니 문자열로 넘긴다.
  await page.addInitScript(`localStorage.setItem("soul-dashboard-theme",${JSON.stringify(theme)});localStorage.setItem("ls.webglGlass","0");Object.defineProperty(navigator.serviceWorker,"register",{configurable:true,value:async()=>({update:async()=>undefined,active:null,addEventListener:()=>undefined})});Object.defineProperty(navigator.serviceWorker,"controller",{configurable:true,get:()=>null});`);
  await installV3VisualQaRoutes(page,{unifiedFolderView:true,postitCards:cards});
  let failDetail=false;
  await page.route("**/api/cards/deps-*/**",route=>route.fulfill({status:200,json:{card:cards.find(card=>route.request().url().includes(card.id)),reports:[],questions:[],sessions:[]}}));
  await page.route("**/api/cards/deps-*",route=>failDetail?route.fulfill({status:503,json:{message:"읽기 실패"}}):route.fulfill({status:200,json:{card:cards.find(card=>route.request().url().endsWith(card.id)),reports:[],questions:[],sessions:[]}}));
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
  await page.locator('[data-card-id="deps-3"]').scrollIntoViewIfNeeded();
  await shot(page,`stopped-${width}-${theme}.png`);
  await page.locator('[data-card-id="deps-0"]').scrollIntoViewIfNeeded();
  await page.locator('[data-card-id="deps-0"] .v3-postit-open').click();
  const detail=page.getByTestId("card-detail");await detail.waitFor();
  const dependencyRow=detail.locator(".v3-card-dependency-row").first();await dependencyRow.waitFor();
  await shot(page,`detail-${width}-${theme}.png`);
  await detail.getByRole("button",{name:"카드 상태 변경"}).click();
  await page.locator("[data-card-status-picker]").getByRole("button",{name:"실행 중",exact:true}).click();
  const dialog=page.getByRole("alertdialog");await dialog.waitFor();
  await page.waitForTimeout(500);
  if(await page.locator("[data-card-status-picker]").isVisible())throw new Error("상태 메뉴가 확인 창을 가립니다");
  const firstFocus=await page.evaluate(()=>document.activeElement?.textContent);
  await shot(page,`confirm-${width}-${theme}.png`);
  await page.keyboard.press("Tab");const tabFocus=await page.evaluate(()=>document.activeElement?.textContent);
  await page.keyboard.press("Escape");await dialog.waitFor({state:"hidden"});
  const afterEscape=await page.evaluate(()=>document.activeElement?.getAttribute("aria-label"));
  failDetail=true;await detail.getByRole("button",{name:"카드 상태 변경"}).click();
  const picker=page.locator("[data-card-status-picker]");await picker.getByRole("alert").waitFor();
  await shot(page,`error-${width}-${theme}.png`);
  failDetail=false;await picker.getByRole("button",{name:"다시 불러오기"}).click();
  await picker.getByRole("button",{name:"실행 중",exact:true}).waitFor({state:"visible"});
  await page.keyboard.press("Escape");
  const rowBounds=await dependencyRow.evaluate(row=>{const title=row.querySelector(".v3-card-dependency-title")!;const r=row.getBoundingClientRect(),t=title.getBoundingClientRect(),style=getComputedStyle(title);return {row:{left:r.left,right:r.right},title:{left:t.left,right:t.right,width:t.width,scrollWidth:title.scrollWidth,clientWidth:title.clientWidth,overflow:style.overflow,textOverflow:style.textOverflow}};});
  if(rowBounds.title.left<rowBounds.row.left||rowBounds.title.right>rowBounds.row.right||rowBounds.title.width<20||(rowBounds.title.scrollWidth>rowBounds.title.clientWidth&&rowBounds.title.textOverflow!=="ellipsis"))throw new Error(`선행 제목 잘림: ${JSON.stringify(rowBounds)}`);
  const resizedWidth=width===360?1280:360;
  await page.setViewportSize({width:resizedWidth,height:900});
  await page.waitForFunction(target=>document.documentElement.clientWidth===target&&document.documentElement.scrollWidth<=target,resizedWidth,{timeout:5_000}).catch(()=>undefined);
  const resized=await page.evaluate(()=>({clientWidth:document.documentElement.clientWidth,scrollWidth:document.documentElement.scrollWidth}));
  if(resized.scrollWidth>resized.clientWidth)throw new Error(`창 크기 변경 뒤 가로 넘침: ${JSON.stringify(resized)}`);
  await page.setViewportSize({width,height:900});await page.goto(`${base}/components`);
  const sample=page.getByTestId("card-dependency-samples");await sample.waitFor();
  const reviewSwitch=sample.getByRole("switch",{name:"검수 대기도 끝난 것으로 친다"});await reviewSwitch.scrollIntoViewIfNeeded();
  const releasedSwitch=sample.getByRole("switch",{name:"풀린 카드를 바로 시작한다"});await releasedSwitch.waitFor();
  await shot(page,`settings-${width}-${theme}.png`);
  await reviewSwitch.click();await sample.getByRole("button",{name:"저장",exact:true}).click();
  await sample.getByRole("status").filter({hasText:"저장했습니다"}).waitFor();
  measurements.push({width,theme,firstFocus,tabFocus,afterEscape,resized,rowBounds,document:await page.evaluate(()=>({clientWidth:document.documentElement.clientWidth,scrollWidth:document.documentElement.scrollWidth}))});
  writeFileSync(path.join(output,"metrics.json"),JSON.stringify(measurements,null,2));
  await context.close();
 }
}

async function shot(page:Page,name:string) {
 await page.screenshot({path:path.join(output,name),animations:"disabled"});
}
