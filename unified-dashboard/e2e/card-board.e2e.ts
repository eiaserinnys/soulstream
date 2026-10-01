import { test, expect } from "@playwright/test";
import { installV3VisualQaRoutes } from "./v3-visual-fixtures";
import { reviewCard, reviewTitle } from "../client/v3/components-review-fixtures";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const output=path.resolve("../../../.local/artifacts/20261001-web-card-board");
const cards=(["todo","queued","running","blocked","review","done","cancelled"] as const).flatMap((status,index)=>
  Array.from({length:status==="todo"?4:1},(_,copy)=>({...reviewCard,id:`product-${index}-${copy}`,folderId:"folder-amber",status,
    title:status==="todo"?reviewTitle:`${status} 카드`,blockedKind:status==="blocked"?"question" as const:null,
    latestActivity:{kind:status==="todo"?"instruction" as const:"report" as const,format:"markdown" as const,
      body:"긴 한국어 원문과 제목이 있어도 열과 카드 폭을 유지합니다. 마지막 지시와 보고는 카드 상세에서 이어 봅니다. ".repeat(6),createdAt:reviewCard.createdAt}})));

for(const width of [1440,1210,390])test(`main and folder board ${width}`,async({page})=>{
  mkdirSync(output,{recursive:true});const reads:string[]=[],writes:string[]=[];
  await page.setViewportSize({width,height:width===1210?834:1000});
  await page.addInitScript(()=>{localStorage.setItem("ls.webglGlass","0");Object.defineProperty(navigator.serviceWorker,"register",{configurable:true,value:async()=>({update:async()=>{},active:null,addEventListener:()=>{}})});});
  await installV3VisualQaRoutes(page,{unifiedFolderView:true,postitCards:cards});
  page.on("request",request=>{if(new URL(request.url()).pathname.startsWith("/api/cards")){
    if(request.method()==="GET")reads.push(new URL(request.url()).pathname+new URL(request.url()).search);
    else writes.push(request.url());
  }});
  const capture=async(name:string)=>page.screenshot({path:path.join(output,`${name}-${width}.png`),animations:"disabled"});
  await page.goto("/");const inbox=page.locator(".v3-card-inbox");await expect(inbox).toBeVisible();await capture("after-main-general");
  const generalCount=await inbox.locator(".v3-postit-card").count();
  await inbox.getByRole("button",{name:"보드",exact:true}).click();const globalBoard=inbox.locator(".v3-card-board");
  await expect(globalBoard.locator("[data-board-column]")).toHaveCount(6);
  await expect(globalBoard.locator('[data-board-column="todo"] .v3-postit-card')).toHaveCount(4);
  await expect(globalBoard.locator('[data-board-column="done"] .v3-postit-card')).toHaveCount(1);
  await expect(inbox.getByRole("switch")).toHaveCount(0);expect(reads).toContain("/api/cards");
  expect(reads.some(url=>/^\/api\/cards\//.test(url))).toBe(false);
  const mainMetrics=await globalBoard.evaluate(element=>({clientWidth:element.clientWidth,scrollWidth:element.scrollWidth,
    cardWidth:getComputedStyle(element.querySelector(".v3-postit-card")!).width,
    laneScroll:element.querySelector(".v3-card-board-lane")!.scrollHeight>element.querySelector(".v3-card-board-lane")!.clientHeight,
    headerY:[...element.querySelectorAll(".v3-detail-section-head")].map(e=>e.getBoundingClientRect().y)}));
  expect(mainMetrics.scrollWidth).toBeGreaterThan(mainMetrics.clientWidth);expect(mainMetrics.laneScroll).toBe(true);
  expect(new Set(mainMetrics.headerY).size).toBe(1);await capture("after-main-board");
  await globalBoard.evaluate(element=>element.scrollLeft=element.scrollWidth);await capture("after-main-board-end");
  await inbox.getByRole("button",{name:"일반 보기",exact:true}).click();await expect(inbox.locator(".v3-postit-card")).toHaveCount(generalCount);
  if(width===390){await page.getByTestId("v3-mobile-tab-projects").click();await page.getByTestId("v3-mobile-project-list").getByRole("button",{name:"소울스트림",exact:true}).click();}
  else await page.getByTestId("v3-all-projects").getByRole("button",{name:"소울스트림",exact:true}).click();
  const folder=page.getByTestId("folder-card-section");await expect(folder).toBeVisible();await folder.scrollIntoViewIfNeeded();
  await expect(folder.locator('[data-card-status="done"]')).toHaveCount(0);await expect(folder).toContainText("완료 1개 숨김");
  expect(reads).toContain("/api/cards?folderId=folder-amber");await folder.locator(".v3-folder-card-head").scrollIntoViewIfNeeded();await capture("after-folder-general-off");
  await folder.getByRole("button",{name:"보드",exact:true}).click();const folderBoard=folder.locator(".v3-card-board");
  await expect(folderBoard.locator("[data-board-column]")).toHaveCount(6);await expect(folder.locator('[data-card-status="cancelled"]')).toHaveCount(0);
  const folderMetrics=await folderBoard.evaluate(element=>({clientWidth:element.clientWidth,scrollWidth:element.scrollWidth,
    cardWidth:getComputedStyle(element.querySelector(".v3-postit-card")!).width,
    headerY:[...element.querySelectorAll(".v3-detail-section-head")].map(e=>e.getBoundingClientRect().y)}));
  expect(folderMetrics.cardWidth).toBe(mainMetrics.cardWidth);expect(folderMetrics.scrollWidth).toBeGreaterThan(folderMetrics.clientWidth);
  expect(new Set(folderMetrics.headerY).size).toBe(1);await folder.locator(".v3-folder-card-head").scrollIntoViewIfNeeded();await capture("after-folder-board-off");
  await folderBoard.evaluate(element=>element.scrollLeft=element.scrollWidth);await capture("after-folder-board-hidden");
  await folder.getByRole("button",{name:"완료 포함 켜기",exact:true}).click();await expect(folder.getByRole("switch",{name:"완료 포함"})).toBeChecked();
  await expect(folder.locator('[data-card-status="done"]')).toHaveCount(1);await capture("after-folder-board-on");
  await folder.getByRole("button",{name:"일반 보기",exact:true}).click();await expect(folder.locator('[data-card-status="done"]')).toHaveCount(1);await folder.locator(".v3-folder-card-head").scrollIntoViewIfNeeded();await capture("after-folder-general-on");
  expect(writes).toEqual([]);
  writeFileSync(path.join(output,`product-metrics-${width}.json`),JSON.stringify({viewport:{width,height:width===1210?834:1000},reads,writes,mainMetrics,folderMetrics},null,2));
});
