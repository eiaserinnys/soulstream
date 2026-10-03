import { expect, test, type FrameLocator, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { installV3VisualQaRoutes } from "./v3-visual-fixtures";
import { webDialogueGroups } from "../client/v3/dialogues-gallery-groups";

const output = path.resolve("../../../.local/artifacts/20261003-dialogues-horizontal-web");
async function prepare(page: Page, width: number) {
  mkdirSync(output, {recursive:true});
  await page.setViewportSize({width, height:1000});
  await page.emulateMedia({colorScheme:"dark", reducedMotion:"reduce"});
  await page.addInitScript(() => {
    localStorage.setItem("soul-dashboard-theme", "dark");
    localStorage.setItem("ls.webglGlass", "0");
  });
  await installV3VisualQaRoutes(page);
  const errors: string[] = [], writes: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/") && !["GET","HEAD"].includes(request.method())) writes.push(`${request.method()} ${url.pathname}`);
  });
  await page.route("**/api/**", route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/api/auth/config") return route.fulfill({json:{authEnabled:true,devModeEnabled:false}});
    if (pathname === "/api/auth/status") return route.fulfill({json:{authenticated:true,user:{email:"qa@example.test",name:"QA",isAdmin:true}}});
    if (pathname === "/api/ui-events/config") return route.fulfill({json:{enabled:true,flushIntervalMs:1000,maxBatchSize:1,maxQueueSize:500,schemaVersion:"soulstream.ui_event.v1"}});
    return route.fallback();
  });
  return {errors,writes};
}
const frame = (page: Page, id: string) => page.frameLocator(`[data-dialogue="${id}"] iframe`);
async function settledPopup(context: Page | FrameLocator) {
  const popup = context.locator('[data-slot="dialog-popup"]').last();
  await expect(popup).toBeVisible({timeout:15_000});
  await expect(popup).not.toHaveAttribute("data-starting-style");
  await expect(popup).toHaveCSS("opacity", "1");
}
async function shell(page: Page) {
  return page.locator("main").evaluate(el => {
    const r=el.getBoundingClientRect();
    return {x:r.x,width:r.width,documentWidth:document.documentElement.scrollWidth,scrollWidth:el.scrollWidth,clientWidth:el.clientWidth};
  });
}
for (const width of [1440,390]) test(`simultaneous real windows and horizontal rail ${width}`, async ({page}) => {
  const state=await prepare(page,width);
  await page.goto("/dialogues/");
  await expect(page.getByTestId("dialogues-review")).toBeVisible();
  await page.reload();
  await expect(page.locator("[data-dialogue]")).toHaveCount(44);
  const main=await shell(page);
  expect(main.documentWidth).toBe(width);
  expect(main.scrollWidth).toBe(main.clientWidth);
  expect(await page.locator(".v3-task-section-nav").count()).toBe(0);
  await settledPopup(frame(page,"project-create"));
  if(width===1440) {
    await settledPopup(frame(page,"folder-create"));
    const cells=await page.locator('[data-rail="create"] .v3-dialogue-cell').evaluateAll(elements=>elements.slice(0,2).map(el=>{
      const r=el.getBoundingClientRect();return {x:r.x,right:r.right,y:r.y,width:r.width};
    }));
    expect(cells[0].width).toBe(640); expect(cells[1].width).toBe(640);
    expect(cells[1].right).toBeLessThanOrEqual(width); expect(cells[0].y).toBe(cells[1].y);
    expect(cells[1].x-cells[0].right).toBe(24);
    const spacing=await page.locator(".v3-dialogue-gallery-content").evaluate(el=>({gap:getComputedStyle(el).gap,inset:getComputedStyle(el).padding}));
    expect(spacing).toEqual({gap:"32px",inset:"0px"});
    // Prove overflow measurement rejects an actual invalid outer width before restoring it.
    await page.evaluate(()=>document.body.style.width="200vw");
    expect((await shell(page)).documentWidth).toBeGreaterThan(width);
    await page.evaluate(()=>document.body.style.removeProperty("width"));
  } else {
    const rail=page.locator('[data-rail="create"]');
    await rail.evaluate(el=>el.scrollLeft=el.clientWidth+24);
    await settledPopup(frame(page,"folder-create"));
    expect(await rail.evaluate(el=>el.scrollLeft)).toBeGreaterThan(0);
    expect((await shell(page)).documentWidth).toBe(width);
  }
  await page.screenshot({path:path.join(output,`gallery-${width}.png`),animations:"disabled"});
  const originalSurface=await frame(page,width===1440?"project-create":"folder-create").locator('[data-slot="dialog-popup"]').evaluate(el=>{
    const header=el.querySelector('[data-slot="dialog-header"]')!;
    const button=el.querySelector('[data-slot="button"]')!;
    const s=getComputedStyle(button);
    return {headerPadding:getComputedStyle(header).padding,font:s.fontSize,buttonPadding:s.padding,scale:getComputedStyle(el).scale};
  });
  await frame(page,width===1440?"project-create":"folder-create").locator('[data-slot="dialog-popup"]').screenshot({path:path.join(output,`original-surface-${width}.png`),animations:"disabled"});
  expect(state.errors).toEqual([]); expect(state.writes).toEqual([]);
  const galleryWrites=[...state.writes];
  await page.goto("/components");
  await expect(page.getByTestId("components-review")).toBeVisible();
  const components=await shell(page); expect(components).toEqual(main);
  await page.screenshot({path:path.join(output,`components-${width}.png`),animations:"disabled"});
  writeFileSync(path.join(output,`layout-${width}.json`),JSON.stringify({main,components,originalSurface,writes:galleryWrites,errors:state.errors},null,2));
});

test("search, close/reopen, local saves, attachments and expansion",async({page})=>{
  const state=await prepare(page,1440);
  await page.goto("/dialogues");
  await settledPopup(frame(page,"project-create"));
  await frame(page,"project-create").getByRole("button",{name:"취소",exact:true}).click();
  await expect(frame(page,"project-create").getByRole("button",{name:"다시 열기"})).toBeVisible();
  await frame(page,"project-create").getByRole("button",{name:"다시 열기"}).click();
  await settledPopup(frame(page,"project-create"));
  const search=page.getByLabel("다이얼로그 이름 검색");
  await search.fill("새 카드");
  await expect(page.locator("[data-dialogue]")).toHaveCount(1);
  const card=frame(page,"card-create");
  await card.getByLabel("카드 제목",{exact:true}).fill("로컬 카드");
  await card.getByLabel("요청 원문",{exact:true}).fill("샘플 생성");
  await card.getByLabel("카드 저장",{exact:true}).click();
  await expect(card.getByRole("status")).toContainText("카드 저장");
  await search.fill("카드 상세 확대");
  const detail=frame(page,"card-detail");
  await expect(detail.getByTestId("card-detail")).toBeVisible();
  await detail.locator('[data-testid="card-detail"] input[type=file]').setInputFiles({name:"local.txt",mimeType:"text/plain",buffer:Buffer.from("샘플 첨부")});
  await detail.getByPlaceholder("커멘트",{exact:true}).fill("샘플 첨부 커멘트");
  await detail.getByRole("button",{name:"커멘트 전송",exact:true}).click();
  await expect(detail.getByText("샘플 첨부 커멘트",{exact:false}).first()).toBeVisible();
  await search.fill("카드 보고 이미지 확대");
  await settledPopup(frame(page,"card-image"));
  await expect(frame(page,"card-image").locator('[data-slot="dialog-popup"] img')).toBeVisible();
  await page.screenshot({path:path.join(output,"image-expanded.png"),animations:"disabled"});
  // Prove this recorder detects a write inside a sample iframe; the probe is fully mocked.
  await frame(page,"card-image").locator("body").evaluate(()=>fetch("/api/recording-probe",{method:"POST"}));
  expect(state.writes).toEqual(["POST /api/recording-probe"]); state.writes.length=0;
  await page.waitForTimeout(1100);
  expect(state.writes).toEqual([]); expect(state.errors).toEqual([]);
  writeFileSync(path.join(output,"mutations.json"),JSON.stringify(state,null,2));
});
for(const group of webDialogueGroups.filter(group=>group.id!=="native")) test(`auto-open original surfaces: ${group.title}`,async({page})=>{
  const state=await prepare(page,group.id==="mobile"?390:640);
  const opened: string[]=[];
  for(const id of group.ids) {
    console.log(`auto-open: ${id}`);
    await page.goto(`/dialogues?sample=${id}`);
    await expect(page.getByTestId("dialogue-sample")).toBeVisible();
    await expect(page.locator('[role="dialog"], [data-slot="popover-popup"], .v3-workspace-scrim, .v3-card-board-overlay, [role="menu"]').first()).toBeVisible();
    expect(await page.locator("iframe").count()).toBe(0);
    expect(await page.locator("canvas").count()).toBe(0);
    opened.push(id);
    if(group.id==="mobile") await page.screenshot({path:path.join(output,`${id}-390.png`),animations:"disabled"});
  }
  expect(state.errors).toEqual([]);expect(state.writes).toEqual([]);
  writeFileSync(path.join(output,`inventory-${group.id}.json`),JSON.stringify({opened,...state},null,2));
});

test("whole preview pair and original surface comparison capture", async ({page}) => {
  const state=await prepare(page,1440);
  await page.setViewportSize({width:1440,height:1200});
  await page.goto("/dialogues");
  await settledPopup(frame(page,"project-create")); await settledPopup(frame(page,"folder-create"));
  const starts = await Promise.all(["project-create","folder-create"].map(async id => frame(page,id).locator('[data-slot="dialog-popup"]').evaluate(el => el.getBoundingClientRect().y)));
  expect(Math.abs(starts[0]-starts[1])).toBeLessThanOrEqual(1);
  const controls=await page.locator(".v3-dialogue-controls").evaluate(el=>({gap:getComputedStyle(el).gap,headerMargin:getComputedStyle(el.closest("article")!.querySelector("header")!).marginBottom,galleryGap:getComputedStyle(el.closest("article")!).gap}));
  expect(controls).toEqual({gap:"12px",headerMargin:"0px",galleryGap:"24px"});
  await page.screenshot({path:path.join(output,"gallery-pair-1440.png"),animations:"disabled"});
  // Compare the same untouched actual form in the single-sample document at its original viewport.
  const preview=await frame(page,"project-create").locator('[data-slot="dialog-popup"]').evaluate(el=>{
    const header=el.querySelector('[data-slot="dialog-header"]')!;
    const button=el.querySelector('[data-slot="button"]')!;
    return {header:getComputedStyle(header).padding,font:getComputedStyle(button).fontSize,padding:getComputedStyle(button).padding,width:el.getBoundingClientRect().width};
  });
  await page.setViewportSize({width:640,height:640});
  await page.goto("/dialogues?sample=project-create"); await settledPopup(page);
  const original=await page.locator('[data-slot="dialog-popup"]').evaluate(el=>{
    const header=el.querySelector('[data-slot="dialog-header"]')!;
    const button=el.querySelector('[data-slot="button"]')!;
    return {header:getComputedStyle(header).padding,font:getComputedStyle(button).fontSize,padding:getComputedStyle(button).padding,width:el.getBoundingClientRect().width};
  });
  expect(original).toEqual(preview);
  await page.screenshot({path:path.join(output,"original-project-640.png"),animations:"disabled"});
  expect(state.errors).toEqual([]);expect(state.writes).toEqual([]);
  writeFileSync(path.join(output,"surface-comparison.json"),JSON.stringify({preview,original,starts,controls,...state},null,2));
});

test("compact controls and top-aligned rail on phone", async ({page}) => {
  const state = await prepare(page,390);
  await page.goto("/dialogues");
  await settledPopup(frame(page,"project-create"));
  const first = await frame(page,"project-create").locator('[data-slot="dialog-popup"]').evaluate(el=>el.getBoundingClientRect().y);
  await page.screenshot({path:path.join(output,"gallery-compact-first-390.png"),animations:"disabled"});
  await page.locator('[data-rail="create"]').evaluate(el=>el.scrollLeft=el.clientWidth+24);
  await settledPopup(frame(page,"folder-create"));
  const second = await frame(page,"folder-create").locator('[data-slot="dialog-popup"]').evaluate(el=>el.getBoundingClientRect().y);
  expect(Math.abs(first-second)).toBeLessThanOrEqual(1);
  expect((await shell(page)).documentWidth).toBe(390);
  await page.screenshot({path:path.join(output,"gallery-compact-second-390.png"),animations:"disabled"});
  expect(state.errors).toEqual([]); expect(state.writes).toEqual([]);
  writeFileSync(path.join(output,"compact-390.json"),JSON.stringify({first,second,...state},null,2));
});
