import { expect, test } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { installV3VisualQaRoutes } from "./v3-visual-fixtures";
import { reviewCard } from "../client/v3/components-review-fixtures";

const output = path.resolve("../../../.local/artifacts/20261001-web-ui-v2");
const phase = process.env.COMPONENTS_REVIEW_PHASE;
if (!phase) throw new Error("COMPONENTS_REVIEW_PHASE required");
mkdirSync(output, { recursive: true });

for (const width of [1440, 390]) test(`web feedback v2 ${width}`, async ({ page }) => {
  await page.setViewportSize({ width, height: 1000 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.addInitScript(() => {
    localStorage.setItem("soul-dashboard-theme", "dark");
    localStorage.setItem("ls.webglGlass", "0");
    localStorage.setItem("soul-user-preferences:qa@example.test", JSON.stringify({ chatFontSize: 17 }));
  });
  await installV3VisualQaRoutes(page, { unifiedFolderView: true, timelineEventCount: 1 });
  await page.route("**/api/auth/config", r => r.fulfill({ json: { authEnabled: true, devModeEnabled: false } }));
  await page.route("**/api/auth/status", r => r.fulfill({ json: { authenticated: true, user: { email: "qa@example.test", name: "QA", isAdmin: true } } }));
  await page.route("**/api/user/preferences", r => r.fulfill({ json: { preferences: { chatFontSize: 17 }, hasBackground: false } }));
  await page.goto("/components");
  await expect(page.getByTestId("components-review")).toBeVisible();
  const capture = async (name: string) => {
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: path.join(output, `${phase}-${width}-${name}.png`), animations: "disabled" });
  };
  await capture("rows");
  await page.locator('[data-component="CardRowView / RunRowFrame actions"]').scrollIntoViewIfNeeded();
  await capture("card-state-comparison");
  const actionRows = await page.locator('[data-component="CardRowView / RunRowFrame actions"] .v3-run-row').evaluateAll(rows => rows.map(row => {
    const action = row.querySelector(".dashboard-icon-cap")!.getBoundingClientRect();
    const chip = row.querySelector('[data-slot="status-chip"]')!.getBoundingClientRect();
    const time = row.querySelector("time")!.getBoundingClientRect();
    const info = row.querySelector(".v3-run-trailing")!.getBoundingClientRect();
    return { h: row.getBoundingClientRect().height, actionW: action.width, actionH: action.height,
      right: action.right, chipRight: chip.right, timeRight: time.right, gap: action.left - info.right, center:action.y + action.height/2 - info.y - info.height/2 };
  }));
  expect.soft(actionRows[0]).toEqual(actionRows[1]);
  expect.soft(actionRows[2].h).toBeLessThan(actionRows[0].h);
  for (const row of actionRows) { expect.soft(row.gap).toBeGreaterThanOrEqual(0); expect.soft(Math.abs(row.center)).toBeLessThanOrEqual(1); }
  const rows = await page.locator(".v3-run-row").evaluateAll(rows => rows.map(row => {
    const open = row.querySelector(".v3-run-open")!;
    const avatar = row.querySelector(".v3-run-avatar")!.getBoundingClientRect();
    const title = row.querySelector(".v3-run-title-line")!.getBoundingClientRect();
    const agent = row.querySelector(".v3-run-agent-line")?.getBoundingClientRect() ?? title;
    const o = open.getBoundingClientRect(), s = getComputedStyle(open);
    return { variant:row.getAttribute("data-row-variant"), avatarCenter:avatar.y+avatar.height/2-(title.y+title.height/2), left: avatar.left - o.left, gap: title.left - avatar.right, padding: s.padding,
      titleCenter: title.y + title.height / 2, agentCenter: agent.y + agent.height / 2,
      portraitTop: avatar.y - title.y, portraitBottom: avatar.bottom - agent.bottom,
      height: o.height, previewMargin: getComputedStyle(open.querySelector("small") ?? open).margin };
  }));
  for (const row of rows) { expect.soft(row.left).toBeCloseTo(row.gap, 0); if(row.variant==="folder") expect.soft(row.avatarCenter).toBeCloseTo(0,0); else {expect.soft(row.portraitTop).toBeCloseTo(0, 0); expect.soft(row.portraitBottom).toBeCloseTo(0, 0);} }
  expect.soft(await page.locator('.v3-task-card .v3-run-open').count()).toBe(2);
  if(process.env.ROWS_ONLY) {writeFileSync(path.join(output,`${phase}-${width}-row-metrics.json`),JSON.stringify({rows,actionRows},null,2));return;}
  await page.locator("#components-heads").scrollIntoViewIfNeeded(); await capture("heads");
  await page.locator("#components-input").scrollIntoViewIfNeeded(); await capture("input-empty");
  const measureInput = () => page.locator('[data-testid="card-composer"]').evaluate(el => {
    const input = el.querySelector("textarea")!, s = getComputedStyle(input), r = input.getBoundingClientRect();
    const line = parseFloat(s.lineHeight);
    const last = r.bottom - parseFloat(s.paddingBottom) - line / 2;
    return { font: s.fontSize, line, padding: s.padding, height: r.height,
      last, centers: [...el.querySelectorAll('button')].map(b => { const q = b.getBoundingClientRect(); return q.y + q.height / 2; }) };
  });
  const empty = await measureInput();
  await page.getByLabel("검수 메시지").fill("한 줄 입력"); await capture("input-one-line");
  const oneLine = await measureInput();
  await page.getByLabel("검수 메시지").fill("첫 줄\n둘째 줄\n셋째 줄");
  await capture("input-multiline"); const multiline = await measureInput();
  for (const input of [empty, oneLine, multiline]) { expect.soft(input.font).toBe("17px"); for (const c of input.centers) expect.soft(Math.abs(c - input.last)).toBeLessThanOrEqual(1); }
  await page.locator("#components-controls").scrollIntoViewIfNeeded(); await capture("controls");
  const treeNames = await page.locator("#components-controls .v3-project-nav-link").evaluateAll(links => links.map(link => ({ name: link.getAttribute("aria-label"), x: link.querySelector("span")!.getBoundingClientRect().x })));
  expect.soft(treeNames[0].x).toBe(treeNames[1].x);
  await page.getByRole("button", { name: "샘플 폴더 선택" }).click();
  await page.getByRole("tab", { name: "전체", exact: true }).click(); await capture("emoji-picker");
  const pickerNames = await page.locator(".v3-folder-picker .v3-project-nav-link").evaluateAll(links => links.map(link => ({ name: link.getAttribute("aria-label"), x: link.querySelector("span")!.getBoundingClientRect().x })));
  expect.soft(pickerNames[0].x).toBe(pickerNames[1].x);
  await page.keyboard.press("Escape");
  const controls = page.getByTestId("components-review-controls");
  expect.soft(await controls.getByRole("combobox").count()).toBe(3);
  expect.soft(await controls.locator("select").count()).toBe(0);
  const agentSelect = controls.getByRole("combobox", { name: "에이전트 선택", exact: true });
  if (await agentSelect.count() && await agentSelect.evaluate(el => el.tagName !== "SELECT")) {
    await agentSelect.click(); await capture("agent-options");
    await page.getByRole("option", { name: "서소영", exact: true }).click();
    await expect(agentSelect).toContainText("서소영");
    await controls.getByRole("combobox", { name: "모델 선택" }).click(); await capture("model-options");
    await expect(page.getByRole("option", { name: /사용 불가 샘플/ })).toHaveAttribute("aria-disabled", "true");
    await page.keyboard.press("Escape");
  }
  await page.locator("#components-surfaces").scrollIntoViewIfNeeded(); await capture("description-view");
  const panel = page.locator(".v3-description-shell").first();
  const box = () => panel.evaluate(el => { const surface = el.firstElementChild!, s = getComputedStyle(surface), r = surface.getBoundingClientRect(); return { x:r.x,y:r.y,w:r.width,h:r.height,padding:s.padding,radius:s.borderRadius,background:s.backgroundColor,cap:surface.querySelector("button.dashboard-icon-cap")?.getBoundingClientRect().toJSON() }; });
  const view = await box();
  await panel.getByRole("button", { name: "폴더 설명 편집", exact: true }).first().click();
  await capture("description-edit"); const edit = await box();
  for (const key of ["x", "w", "padding", "radius", "background"] as const) expect.soft(edit[key]).toBe(view[key]);
  expect.soft(await panel.locator('[data-slot="chat-input-composer"]').count()).toBe(0);
  expect.soft(await panel.locator(".dashboard-icon-cap--small").count()).toBe(1);
  await page.getByLabel("폴더 설명 마크다운").fill("긴 설명\n".repeat(30) + "마지막 줄");
  await page.getByLabel("폴더 설명 마크다운").press("Control+End"); await capture("description-long");
  await page.getByLabel("폴더 설명 마크다운").press("Control+Enter");
  await expect(page.getByLabel("폴더 설명 마크다운")).toHaveCount(0);
  const cards = ["blocked", "review"].map((status, i) => ({ ...reviewCard, status, id: `qa-state-${status}`, folderId: "folder-amber", assigneeSessionId: null, positionKey: String(i), title: "상태별 같은 카드", request: "같은 미리보기" }));
  await page.route("**/api/cards?**", r => r.fulfill({ json: { cards: new URL(r.request().url()).searchParams.get("folderId") === "folder-amber" ? cards : [] } }));
  await page.route("**/api/cards/qa-state-*", r => {
    const card = cards.find(card => r.request().url().endsWith(card.id));
    return r.fulfill({ json: { card, reports: [], questions: [], sessions: [], comments: [] } });
  });
  await page.goto("/");
  if (width < 760) {
    await page.getByTestId("v3-mobile-tab-projects").click();
    await page.getByTestId("v3-mobile-project-list").getByRole("button", { name: "소울스트림", exact: true }).click();
  } else await page.getByTestId("v3-all-projects").getByRole("button", { name: "소울스트림", exact: true }).click();
  const context = page.getByTestId("v3-project-context");
  await expect(context).toBeVisible(); await capture("operational-folder");
  await context.scrollIntoViewIfNeeded(); await capture("operational-context");
  await page.locator(".v3-child-folders").scrollIntoViewIfNeeded(); await capture("operational-subfolders");
  const operationalCards = page.getByTestId('v3-folder-cards-section').locator('.v3-card-row[data-card-id^="qa-state-"]');
  await expect(operationalCards).toHaveCount(2);
  await operationalCards.first().scrollIntoViewIfNeeded(); await capture("operational-card-states");
  const operationalActions = await operationalCards.evaluateAll(rows => rows.map(row => {
    const action = row.querySelector(".dashboard-icon-cap")!.getBoundingClientRect(), r = row.getBoundingClientRect();
    return { width: action.width, height: action.height, rightInset: r.right - action.right, rowHeight: r.height };
  }));
  expect.soft(operationalActions[0]).toEqual(operationalActions[1]);
  writeFileSync(path.join(output, `${phase}-${width}-metrics.json`), JSON.stringify({ rows, actionRows, treeNames, pickerNames, empty, oneLine, multiline, view, edit, operationalActions }, null, 2));
});
