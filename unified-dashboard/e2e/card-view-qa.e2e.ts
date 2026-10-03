import { expect, test, type Locator } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { installV3VisualQaRoutes } from "./v3-visual-fixtures";
import { reviewCard } from "../client/v3/components-review-fixtures";

const output = path.resolve("../../../.local/artifacts/20261004-web-card-view-qa");
const phase = process.env.WEB_CARD_QA_PHASE ?? "after";
const preset = { id: "codex-6.1-sol", label: "Codex - 6.1 Sol", backend: "codex", available: true,
  reason: "quota_exhausted", reason_label: "7일 사용량 제한", resets_at: null, usage_warning: false };
mkdirSync(output, { recursive: true });
async function inputGeometry(scope: Locator) {
  return scope.evaluate(el => {
    const rect = (selector: string) => {
      const node = el.querySelector(selector)!, r = node.getBoundingClientRect(), s = getComputedStyle(node);
      return { x: r.x, right: r.right, y: r.y, bottom: r.bottom, width: r.width, height: r.height,
        padding: s.padding, font: s.font, radius: s.borderRadius };
    };
    const frame = el.getBoundingClientRect();
    const controls = rect(".v3-card-handoff-controls"), body = rect('[data-slot="chat-input-body"]');
    const surface = rect('[data-slot="chat-input-composer"]');
    return { outerGap: controls.y - frame.y - parseFloat(getComputedStyle(el).borderTopWidth), innerGap: surface.y - controls.bottom, controls, body, surface,
      send: rect('[data-testid="send-button"]'), chip: rect(".v3-card-handoff-chip") };
  });
}
for (const width of [1440, 390]) test(`operational board and handoff ${width}`, async ({ page }) => {
  await page.setViewportSize({ width, height: 1000 });
  await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "dark" });
  await page.addInitScript(() => {
    localStorage.setItem("soul-dashboard-theme", "dark"); localStorage.setItem("ls.webglGlass", "0");
    localStorage.setItem("cards-p1-handoff", JSON.stringify({folderId:"folder-amber",nodeId:"eiaserinnys",agentId:"roselin_codex",modelPreset:""}));
  });
  const cards = Array.from({length: width === 1440 ? 2 : 0}, (_, index) => ({...reviewCard,
    id: `draft-${index}`, folderId: "folder-amber", status: "todo" as const, title: `드래프트 ${index + 1}` }));
  const payloads: Record<string, unknown>[] = [];
  await installV3VisualQaRoutes(page, { unifiedFolderView: true, postitCards: cards,
    onSessionCreate: payload => payloads.push(payload) });
  await page.route("**/api/nodes/*/agents", route => route.fulfill({json:{agents:[{id:"roselin_codex",
    name:"아주 긴 실행 에이전트 이름을 선택한 상태입니다 ".repeat(3),backend:"codex",default_preset:preset.id}]}}));
  await page.route("**/api/nodes/*/model-presets", route => route.fulfill({json:{model_presets:[preset]}}));
  await page.goto("/");
  const home = page.getByTestId("card-home"), handoff = home.locator(".v3-today-handoff");
  const input = handoff.getByRole("textbox", {name:"세션 첫 메시지"});
  await expect(input).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  const empty = await inputGeometry(handoff);
  await page.screenshot({path:path.join(output,`${phase}-main-${width}.png`),animations:"disabled"});
  writeFileSync(path.join(output,`${phase}-empty-${width}.json`),JSON.stringify(empty,null,2));
  // RED baseline demonstrates that this assertion detects the reported additive spacing defect.
  expect(empty.innerGap).toBeLessThan(empty.outerGap);
  const board = home.locator(".v3-card-board"), draft = board.locator('[data-board-column="todo"]');
  const head = draft.locator(".v3-detail-section-head"), add = head.getByRole("button",{name:"새 카드",exact:true});
  await expect(head).toContainText(`드래프트${cards.length}개`);
  await expect(add).toHaveAttribute("data-slot","dashboard-icon-cap");
  await expect(add).toHaveClass(/dashboard-icon-cap--small/);
  const boardGeometry = await board.evaluate(el => ({
    heads:[...el.querySelectorAll('.v3-card-board-column > .v3-detail-section-head')].map(node=>node.getBoundingClientRect().y),
    lanes:[...el.querySelectorAll('.v3-card-board-lane')].map(node=>node.getBoundingClientRect().y),
    draft:[...el.querySelectorAll('[data-board-column="todo"] .v3-detail-section-head > *')].map(node=>{
      const r=node.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};}),
  }));
  expect(Math.max(...boardGeometry.lanes)-Math.min(...boardGeometry.lanes)).toBeLessThanOrEqual(1);
  expect(Math.max(...boardGeometry.heads)-Math.min(...boardGeometry.heads)).toBeLessThanOrEqual(1);
  const centers=boardGeometry.draft.map(r=>r.y+r.height/2);
  expect(Math.max(...centers)-Math.min(...centers)).toBeLessThanOrEqual(1);
  await add.click(); await expect(page.getByRole("dialog",{name:"새 카드",exact:true})).toBeVisible();
  await page.getByRole("button",{name:"취소",exact:true}).click();
  const text = "작성 중인 긴 문장을 보존합니다.\n".repeat(30);
  await input.fill(text); await input.focus();
  await handoff.getByRole("button",{name:"실행 조합 선택",exact:true}).click();
  const option=page.locator(".v3-card-execution-picker").getByRole("button",{name:preset.label,exact:true});
  await expect(option).toBeEnabled(); await option.click(); await page.keyboard.press("Escape");
  await expect(input).toHaveValue(text);
  await expect(handoff.getByText(preset.label,{exact:true})).toHaveClass("text-destructive");
  const long = await inputGeometry(handoff);
  expect(long.send.height).toBe(empty.send.height); expect(long.chip.height).toBe(empty.chip.height);
  expect(long.send.right).toBeLessThanOrEqual(width); expect(long.innerGap).toBeLessThan(long.outerGap);
  await page.screenshot({path:path.join(output,`${phase}-long-${width}.png`),animations:"disabled"});
  await page.setViewportSize({width:width===390?844:1210,height:width===390?390:834});
  await expect(input).toHaveValue(text);
  await page.setViewportSize({width,height:1000});
  await handoff.getByRole("button",{name:"세션 시작",exact:true}).click();
  await expect.poll(()=>payloads.length).toBe(1); expect(payloads[0]).toMatchObject({model_preset:preset.id});
  if(width<760){await page.getByTestId("v3-mobile-tab-projects").click();await page.getByTestId("v3-mobile-project-list").getByRole("button",{name:"소울스트림",exact:true}).click();}
  else await page.getByTestId("v3-all-projects").getByRole("button",{name:"소울스트림",exact:true}).click();
  const folder=page.getByTestId("folder-card-section");
  await expect(folder.locator('[data-board-column="done"]')).toHaveCount(0);
  await folder.locator('[data-board-column="todo"] .v3-detail-section-head').getByRole("button",{name:"새 카드",exact:true}).click();
  const dialog=page.getByRole("dialog",{name:"새 카드",exact:true});
  await expect(dialog.getByRole("button",{name:"폴더 선택",exact:true})).toHaveText("소울스트림");
  await dialog.getByRole("button",{name:"취소",exact:true}).click();
  await folder.scrollIntoViewIfNeeded();
  await page.screenshot({path:path.join(output,`${phase}-folder-${width}.png`),animations:"disabled"});
  writeFileSync(path.join(output,`${phase}-metrics-${width}.json`),JSON.stringify({empty,long,boardGeometry,payloads},null,2));
});

test("default comment composer comparison",async({page})=>{
  await page.setViewportSize({width:1440,height:1000});
  await page.addInitScript(()=>{localStorage.setItem("ls.webglGlass","0");localStorage.setItem("soul-dashboard-theme","dark");});
  await installV3VisualQaRoutes(page,{unifiedFolderView:true});
  await page.goto("/components");
  await page.getByTestId("card-board-sample").locator(".v3-postit-card").first().getByRole("button",{name:/카드 .* 열기/}).click();
  const detail=page.getByTestId("card-detail");
  await detail.getByPlaceholder("커멘트",{exact:true}).fill("기본 커멘트 입력창 비교");
  await page.evaluate(()=>document.fonts.ready);
  const composer=detail.getByTestId("card-composer");
  const metrics=await composer.evaluate(el=>{
    const surface=el.querySelector('[data-slot="chat-input-composer"]')!,body=el.querySelector('[data-slot="chat-input-body"]')!,send=el.querySelector('[data-testid="send-button"]')!;
    const box=(node:Element)=>{const r=node.getBoundingClientRect(),s=getComputedStyle(node);return {x:r.x,y:r.y,width:r.width,height:r.height,padding:s.padding,font:s.font,radius:s.borderRadius};};
    return {root:box(el),surface:box(surface),body:box(body),send:box(send)};
  });
  await detail.screenshot({path:path.join(output,`${phase}-default-comment.png`),animations:"disabled"});
  writeFileSync(path.join(output,`${phase}-default-comment.json`),JSON.stringify(metrics,null,2));
  if(phase==="after")expect(metrics).toEqual(JSON.parse(readFileSync(path.join(output,"before-default-comment.json"),"utf8")));
});

test("review window uses the actual draft action and handoff",async({page})=>{
  await page.setViewportSize({width:1440,height:1000});
  await page.emulateMedia({reducedMotion:"reduce"});
  await page.addInitScript(()=>localStorage.setItem("ls.webglGlass","0"));
  await installV3VisualQaRoutes(page,{unifiedFolderView:true});
  await page.goto("/components");
  const sample=page.getByTestId("card-board-sample");
  await sample.locator('[data-board-column="todo"] .v3-detail-section-head').getByRole("button",{name:"새 카드",exact:true}).click();
  await expect(page.getByRole("dialog",{name:"새 카드",exact:true})).toBeVisible();
  await page.getByRole("button",{name:"취소",exact:true}).click();
  await sample.getByRole("button",{name:"전부 완료",exact:true}).click();
  await expect(sample.locator('[data-board-column="todo"] .v3-detail-section-head')).toContainText("드래프트0개");
  await sample.scrollIntoViewIfNeeded();
  await page.screenshot({path:path.join(output,`${phase}-review-board.png`),animations:"disabled"});
  await page.locator("#components-input").scrollIntoViewIfNeeded();
  await expect(page.locator(".v3-card-handoff")).toBeVisible();
  await page.screenshot({path:path.join(output,`${phase}-review-input.png`),animations:"disabled"});
});
