import { test, expect, type Page, type Locator } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { reviewSession } from "../client/v3/components-review-fixtures";
import { installV3VisualQaRoutes } from "./v3-visual-fixtures";

const output = path.resolve("../../..",".local/artifacts/20261002-1410-session-menu");
const labels = ["세션 ID 복사","이 세션을 이어서 시작하기","리밋이 풀릴 때 재개",
  "재개 예약 취소","이름 변경","다른 폴더로 이동","삭제"];
async function setup(page:Page) {
  await page.addInitScript(()=>{
    localStorage.setItem("ls.webglGlass","0");
    localStorage.setItem("soul-dashboard-theme","dark");
    const sw=navigator.serviceWorker;
    if(sw) Object.defineProperty(sw,"register",{configurable:true,value:async()=>({update:async()=>undefined,active:null,installing:null,addEventListener:()=>undefined,removeEventListener:()=>undefined})});
  });
  await installV3VisualQaRoutes(page,{unifiedFolderView:true});
}
async function capture(page:Page,name:string) {
  mkdirSync(output,{recursive:true});
  await page.screenshot({path:path.join(output,name+".png"),fullPage:false,animations:"disabled",timeout:10000});
}
async function menu(page:Page,row:Locator) {
  await row.click({button:"right"});
  const popup = page.locator("[data-slot='menu-popup']:visible");
  await expect(popup).toBeVisible();
  for (const label of labels) await expect(popup.getByRole("menuitem",{name:new RegExp("^"+label)})).toBeVisible();
  return popup;
}

test("wide operational feed and review row/header use the complete menu and existing picker",async({page})=>{
  page.on("pageerror", error => console.error(error.message));
  await page.setViewportSize({width:1440,height:1000});
  await setup(page);
  await page.goto("/");
  await expect(page.getByTestId("v3-session-panel")).toBeVisible();
  await capture(page,"wide-operational-before-menu");
  const row = page.getByTestId("v3-session-panel").locator(".v3-run-row").first();
  let popup = await menu(page,row);
  await capture(page,"wide-feed-menu");
  await popup.getByRole("menuitem",{name:"다른 폴더로 이동",exact:true}).click();
  await expect(page.locator(".v3-folder-picker")).toBeVisible();
  await capture(page,"wide-feed-folder-picker");
  await page.getByRole("button",{name:"취소",exact:true}).click();
  await capture(page,"wide-operational-after-menu");
  await page.goto("/components");
  const sample = page.locator('[data-component="공통 세션 메뉴 / FolderMoveDialog / SessionSuccessionModal"]');
  await sample.scrollIntoViewIfNeeded();
  popup = await menu(page,sample.locator(".v3-run-row"));
  await page.keyboard.press("Escape");
  popup = await menu(page,sample.locator(".v3-chat-header"));
  await capture(page,"wide-review-header-menu");
  await popup.getByRole("menuitem",{name:"이 세션을 이어서 시작하기",exact:true}).click();
  await expect(page.getByRole("dialog").filter({has:page.getByRole("heading",{name:"새 세션",exact:true})})).toBeVisible();
  await capture(page,"wide-succession");
});

test("narrow light review uses the same actions and folder picker without overflow",async({page})=>{
  page.on("pageerror", error => console.error(error.message));
  await page.setViewportSize({width:390,height:960});
  await setup(page);
  await page.addInitScript(()=>localStorage.setItem("soul-dashboard-theme","light"));
  await page.goto("/components");
  const sample = page.locator('[data-component="공통 세션 메뉴 / FolderMoveDialog / SessionSuccessionModal"]');
  await sample.scrollIntoViewIfNeeded();
  await sample.locator(".v3-run-row").click({button:"right"});
  const dialog = page.getByRole("dialog");
  for (const label of labels) await expect(dialog.getByRole("button",{name:new RegExp("^"+label)})).toBeVisible();
  await capture(page,"narrow-review-menu");
  await dialog.getByRole("button",{name:"다른 폴더로 이동",exact:true}).click();
  await expect(page.locator(".v3-folder-picker")).toBeVisible();
  await capture(page,"narrow-folder-picker");
  const bounds = await page.locator(".v3-folder-picker").boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x+bounds!.width).toBeLessThanOrEqual(391);
});

test("operational session header, search event/session rows and card session history share the owner",async({page})=>{
  await page.setViewportSize({width:1440,height:1000});
  await setup(page);
  await page.route("**/cogito/search**",route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({
    results:[{session_id:"run-beta-1",event_id:1,score:1,preview:"메뉴 이벤트 결과",event_type:"user_message",match_source:"message"}],
    session_results:[{session_id:"run-alpha-child",title:"메뉴 세션 결과",excerpt:"검수",updated_at:"2026-10-01T00:00:00Z",
      task_id:null,task_title:null,parent_session_id:null,best_match:{event_id:1,match_source:"message",excerpt:"검수"},
      evidence:[],session_url:"/?session=run-alpha-child&event=1"}],
  })}));
  await page.goto("/");
  const row = page.getByTestId("v3-session-panel").locator(".v3-run-row").first();
  await row.click();
  let popup = await menu(page,page.locator(".v3-chat-header:visible").first());
  await capture(page,"wide-operational-header-menu");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+K");
  const search = page.getByRole("dialog",{name:"세션 기록 검색"});
  await search.getByPlaceholder("검색어를 입력하세요...").fill("메뉴");
  popup=await menu(page,page.getByTestId("session-search-result"));
  await popup.getByRole("menuitem",{name:"다른 폴더로 이동",exact:true}).click();
  await expect(page.locator(".v3-folder-picker")).toBeVisible();
  await capture(page,"wide-search-folder-picker");
  await page.getByRole("button",{name:"취소",exact:true}).click();
  popup=await menu(page,search.getByText("메뉴 이벤트 결과",{exact:true}));
  await capture(page,"wide-search-event-menu");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.route("**/api/sessions?**",route=>{
    if(new URL(route.request().url()).searchParams.getAll("session_id").includes(reviewSession.agentSessionId))
      return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({sessions:[reviewSession],total:1})});
    return route.fallback();
  });
  await page.goto("/components");
  await page.getByTestId("postit-size-comparison").locator(".v3-postit-open").first().click();
  const card = page.getByTestId("card-detail");
  await card.getByRole("tab",{name:"세션",exact:true}).click();
  popup=await menu(page,card.locator(".v3-card-session-history .v3-run-row"));
  await capture(page,"wide-card-session-menu");
  await page.keyboard.press("Escape");
  const metrics=await card.locator(".v3-card-session-history .v3-run-row").evaluate(el=>{
    const box=el.getBoundingClientRect(); const text=el.querySelector("strong")!;
    return {x:box.x,right:box.right,fontSize:getComputedStyle(text).fontSize};
  });
  writeFileSync(path.join(output,"metrics.json"),JSON.stringify(metrics,null,2));
});

test("an unassigned session moves through REST and updates the returned tree immediately",async({page})=>{
  await page.setViewportSize({width:1440,height:1000});
  await setup(page);
  await page.route("**/api/folders",route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({
    folders:[{id:"rb-alpha",name:"카드 밀도와 계층 최종 QA",parentFolderId:null,projectPageId:"task-alpha",sortOrder:0,status:"open",version:1,archived:false}],
    sessions:{"review-session":{folderId:null,displayName:null},"run-alpha-child":{folderId:null,displayName:null}},
  })}));
  let submitted:string[]=[];
  let boardRequests=0;
  page.on("request",request=>{if(/board-items.*folder/.test(request.url()))boardRequests++;});
  await page.route("**/api/sessions/folder",async route=>{
    const body=route.request().postDataJSON();
    submitted=body.sessionIds;
    expect(route.request().method()).toBe("PATCH");
    expect(body.folderId).toBe("rb-alpha");
    await route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({success:true,count:2,sessionIds:[...submitted,"run-alpha-child"]})});
  });
  await page.goto("/");
  const row=page.getByTestId("v3-session-panel").locator('[data-session-id="review-session"]');
  const rootId=await row.getAttribute("data-session-id");
  let popup=await menu(page,row);
  await popup.getByRole("menuitem",{name:"다른 폴더로 이동",exact:true}).click();
  const picker=page.locator(".v3-folder-picker");
  await picker.locator('[data-folder-id="rb-alpha"] button').last().click();
  await page.getByRole("dialog",{name:"다른 폴더로 이동"}).getByRole("button",{name:"이동",exact:true}).click();
  await expect(picker).toBeHidden();
  expect(submitted).toEqual([rootId]);
  await expect(row.getByText("카드 밀도와 계층 최종 QA",{exact:true})).toBeVisible();
  await capture(page,"wide-unassigned-move-result");
  console.log(JSON.stringify({rootId,initialFolderId:null,targetFolderId:"rb-alpha",submittedRoots:submitted,returnedTree:[...submitted,"run-alpha-child"],boardRequests}));
  expect(boardRequests).toBe(0);
  // Reopening proves the current folder changed locally without a page reload.
  popup=await menu(page,row);
  await popup.getByRole("menuitem",{name:"다른 폴더로 이동",exact:true}).click();
  await expect(page.locator('.v3-folder-picker [data-folder-id="rb-alpha"] button').last()).toBeDisabled();
  await capture(page,"wide-unassigned-move-after-rest");
});

test("folder history, expanded board rows and session board tiles share the complete menu",async({page})=>{
  await page.setViewportSize({width:1440,height:1000});
  await setup(page);
  await page.goto("/");
  await page.getByTestId("v3-starred-tasks").locator(".v3-starred-task-link").first().click();
  const history=page.locator('[data-task-section="sessions"] .v3-run-row').first();
  await menu(page,history);
  await capture(page,"wide-folder-history-menu");
  await page.keyboard.press("Escape");
  await page.getByRole("button",{name:"폴더 보드 열기",exact:true}).click();
  await page.getByTestId("v3-folder-board-resources").getByRole("tab",{name:/세션/}).click();
  await menu(page,page.getByTestId("v3-folder-board-resources").locator(".v3-run-row").first());
  await capture(page,"wide-expanded-board-row-menu");
  await page.keyboard.press("Escape");
  await menu(page,page.getByTestId("board-session-tile").last());
  await capture(page,"wide-board-session-tile-menu");
});


test("session menu stays open on pointer leave and closes through explicit actions", async ({page}) => {
  await page.setViewportSize({width:1440,height:1000});
  await setup(page);
  await page.goto("/");
  const row=page.getByTestId("v3-session-panel").locator(".v3-run-row").first();
  const popup=page.locator("[data-slot='menu-popup']:visible");
  const phase=process.env.SESSION_MENU_VERIFY_PHASE ?? "after";
  await menu(page,row);
  const bounds=(await popup.boundingBox())!;
  await page.mouse.move(bounds.x+bounds.width/2,bounds.y+20);
  await capture(page,`pointer-${phase}-inside`);
  await page.mouse.move(bounds.x-80,bounds.y+20);
  // Allow the primitive's existing close/animation lifecycle to settle before inspecting it.
  await page.waitForTimeout(300);
  await capture(page,`pointer-${phase}-outside`);
  await expect(popup).toBeVisible();
  await page.mouse.click(700,600);
  await expect(popup).toBeHidden();
  await menu(page,row);
  await page.keyboard.press("Escape");
  await expect(popup).toBeHidden();
  await menu(page,row);
  await popup.getByRole("menuitem",{name:"다른 폴더로 이동",exact:true}).click();
  await expect(popup).toBeHidden();
  await expect(page.getByRole("dialog",{name:"다른 폴더로 이동"})).toBeVisible();
  await expect(page.locator(".v3-folder-picker")).toBeVisible();
  await capture(page,"pointer-after-existing-folder-picker");
});
