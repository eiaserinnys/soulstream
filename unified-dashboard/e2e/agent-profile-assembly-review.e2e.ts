import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { openBody } from "./agent-profile-assembly-guides-helpers";
import { guideSkills } from "../client/v3/guides-fixture";
import { installV3VisualQaRoutes } from "./v3-visual-fixtures";

const SKILL_LABEL = guideSkills[1]!.name;
const output = path.resolve("../.local/card1783-captures");
async function open(page: Page, width: number, height: number, state = "normal", section = "에이전트") {
  await page.setViewportSize({ width, height });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.addInitScript(() => { localStorage.setItem("soul-dashboard-theme", "dark"); localStorage.setItem("ls.webglGlass", "0"); });
  await installV3VisualQaRoutes(page);
  await page.route("**/api/**", route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/config") return route.fulfill({ json: { authEnabled: true, devModeEnabled: false } });
    if (path === "/api/auth/status") return route.fulfill({ json: { authenticated: true, user: { email: "qa@example.test", name: "QA", isAdmin: true } } });
    if (path === "/api/ui-events/config") return route.fulfill({ json: { enabled: false, flushIntervalMs: 1000, maxBatchSize: 1, maxQueueSize: 500, schemaVersion: "soulstream.ui_event.v1" } });
    if (path === "/api/health") return route.fulfill({ json: { healthy: true, ready: true, draining: false, build_id: "dev" } });
    if (path === "/api/nodes") return route.fulfill({ json: { nodes: [] } });
    if (path === "/api/nodes/stream") return route.fulfill({ status: 200, contentType: "text/event-stream", body: "event: snapshot\ndata: []\n\n" });
    if (path === "/api/sessions/stream") return route.fulfill({ status: 200, contentType: "text/event-stream", body: 'event: session_list\ndata: {"type":"session_list","sessions":[],"total":0}\n\n' });
    if (path.endsWith("/stream") || path.endsWith("/events")) return route.fulfill({ status: 200, contentType: "text/event-stream", body: ": empty\n\n" });
    return route.fulfill({ status: 200, json: {} });
  });
  await page.goto(`/dialogues?sample=settings&assemblyState=${state}`);
  await expect(page.getByRole("heading", { name: "설정", exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: section, exact: true }).click();
  if (section === "에이전트") await expect(page.getByTestId("agent-profile-editor")).toBeVisible();
  await expect(page.getByText("연결이 끊겼습니다")).toHaveCount(0);
}
async function shot(page: Page, name: string) {
  mkdirSync(output, { recursive: true });
  await page.screenshot({ path: path.join(output, `review-${name}.png`), animations: "disabled" });
}
const row = (page: Page, title: string) => page.getByTestId("agent-context-assembly").locator("button").filter({ hasText: title });
async function setScene(page: Page, value: string) {
  await page.evaluate(value => { const url = new URL(location.href); url.searchParams.set("assemblyState", value); history.replaceState(null, "", url); }, value);
}

test.afterEach(async ({ page }, info) => {
  if (info.status !== info.expectedStatus) await shot(page, `failed-${info.title.replace(/[^a-z0-9-]+/gi, "-")}`).catch(() => {});
});

for (const [width, height] of [[1366, 657], [1280, 632]]) {
  test(`s8 low window assembly ${width}x${height}`, async ({ page }) => {
    await open(page, width, height);
    await expect(row(page, "스킬 목록")).toBeVisible();
    const detail = page.locator(".config-detail");
    const frame = page.getByTestId("agent-profile-editor").locator("..");
    const guidance = page.getByText("프로필 몫만 보입니다. 폴더, 페이지, 세션이 붙이는 글은 빠집니다.");
    await shot(page, `low-list-${width}x${height}`);
    await detail.evaluate(element => { element.scrollTop = element.scrollHeight; });
    const list = await page.evaluate(() => {
      const d = document.querySelector<HTMLElement>(".config-detail")!;
      const f = document.querySelector<HTMLElement>('[data-testid="agent-profile-editor"]')!.parentElement!;
      const scroller = document.querySelector<HTMLElement>('[data-testid="agent-context-assembly"] .overflow-y-auto')!;
      const db = d.getBoundingClientRect(), fb = f.getBoundingClientRect(), sb = scroller.getBoundingClientRect();
      const buttons = Array.from(scroller.querySelectorAll<HTMLButtonElement>("button")).filter(button =>
        button.hasAttribute("data-status") || button.textContent?.trim().startsWith("전체"));
      return { scroll: d.scrollTop, frameTop: fb.top, frameBottom: fb.bottom, frameHeight: fb.height,
        detailTop: db.top, detailBottom: db.bottom,
        rows: buttons.filter(button => { const b = button.getBoundingClientRect(); return b.top >= sb.top - 1 && b.bottom <= sb.bottom + 1; }).length };
    });
    console.log(`low list ${width}x${height}: ${JSON.stringify(list)}`);
    expect(list.scroll).toBeGreaterThan(0);
    expect(list.frameTop).toBeGreaterThanOrEqual(list.detailTop - 1);
    expect(list.detailBottom - list.frameBottom).toBeCloseTo(12, 0);
    // 가장 긴 제목은 두 줄까지 감싸 줄이 한 줄 더 높다(세라피엘 검수 결함 1). 낮은 창에서도 목록이 세 줄은 온전히 보여야 한다.
    expect(list.rows).toBeGreaterThanOrEqual(3);
    const guide = await guidance.boundingBox();
    expect(guide!.y + guide!.height).toBeLessThanOrEqual(list.detailBottom);
    await shot(page, `low-list-end-${width}x${height}`);

    await openBody(page, "공통 지침과 아주 긴 제목");
    const body = page.locator('[data-slot="context-content-fill"]');
    await expect(body).toBeVisible();
    expect((await body.textContent())!.length).toBeGreaterThan(50_000);
    const bodyHeight = (await body.boundingBox())!.height;
    console.log(`low body height ${width}x${height}: ${bodyHeight}`);
    expect(bodyHeight).toBeGreaterThanOrEqual(150);
    await detail.evaluate(element => { element.scrollTop = 0; });
    await shot(page, `low-body-${width}x${height}`);
    await detail.evaluate(element => { element.scrollTop = element.scrollHeight; });
    await shot(page, `low-body-end-${width}x${height}`);
    await body.evaluate(element => { element.scrollTop = element.scrollHeight; });
    const outer = await detail.evaluate(element => {
      const max = element.scrollHeight - element.clientHeight;
      element.scrollTop = max / 2;
      return { before: element.scrollTop, max };
    });
    expect(outer.before).toBeGreaterThan(0);
    expect(outer.before).toBeLessThan(outer.max);
    const bodyBox = (await body.boundingBox())!, detailBox = (await detail.boundingBox())!;
    const visibleTop = Math.max(bodyBox.y, detailBox.y), visibleBottom = Math.min(bodyBox.y + bodyBox.height, detailBox.y + detailBox.height);
    await page.mouse.move(bodyBox.x + bodyBox.width / 2, (visibleTop + visibleBottom) / 2);
    await page.mouse.wheel(0, 700); await page.waitForTimeout(200);
    expect(await detail.evaluate(element => element.scrollTop)).toBe(outer.before);

    await page.getByLabel("소스 목록으로").click();
    await openBody(page, "스킬 목록");
    await page.getByLabel("스킬 정의 원문").selectOption({ label: SKILL_LABEL });
    const skill = page.getByTestId("agent-context-skill-original").locator('[data-slot="context-content-fill"]');
    await expect(skill).toBeVisible();
    const skillHeight = (await skill.boundingBox())!.height;
    console.log(`low skill height ${width}x${height}: ${skillHeight}`);
    expect(skillHeight).toBeGreaterThanOrEqual(150);
    await detail.evaluate(element => { element.scrollTop = element.scrollHeight; });
    await shot(page, `low-skill-end-${width}x${height}`);
    expect((await frame.boundingBox())!.height).toBeCloseTo(list.frameHeight, 0);
  });

  test(`s8 low window bundle ${width}x${height}`, async ({ page }) => {
    await open(page, width, height);
    await page.getByRole("button", { name: "컨텍스트 번들 편집" }).click();
    await page.getByRole("button", { name: "공통 지침과 긴 이름을 가진 검수용 번들" }).click();
    const detail = page.locator(".config-detail"), editor = page.getByTestId("context-bundle-editor");
    const frame = editor.locator("..");
    await shot(page, `low-bundle-${width}x${height}`);
    await detail.evaluate(element => { element.scrollTop = element.scrollHeight; });
    const box = await frame.boundingBox(), outer = await detail.boundingBox();
    const scroll = await detail.evaluate(element => element.scrollTop);
    console.log(`low bundle ${width}x${height}: ${JSON.stringify({ box, outer, scroll })}`);
    expect(scroll).toBeGreaterThan(0);
    expect(box!.height).toBeGreaterThanOrEqual(400);
    expect(box!.y).toBeGreaterThanOrEqual(outer!.y - 1);
    expect(outer!.y + outer!.height - box!.y - box!.height).toBeCloseTo(12, 0);
    await shot(page, `low-bundle-end-${width}x${height}`);
  });
}

for (const width of [1440, 360]) {
  test(`s6 detail reload ${width}`, async ({ page }) => {
    await open(page, width, width === 360 ? 780 : 900, "loading");
    await expect(row(page, "프로필 지침")).toBeVisible({ timeout: 15000 });
    await openBody(page, "프로필 지침");
    const detail = page.getByTestId("agent-context-assembly-detail");
    const select = page.getByLabel("조립 백엔드");
    await select.focus(); await select.selectOption("codex");
    await expect(select).toBeFocused();
    await expect(detail).toContainText("프로필 지침");
    await expect(detail.locator('[data-slot="frame-loading"]')).toBeVisible();
    await shot(page, `reload-${width}`);
    await expect(detail.locator('[data-slot="context-content-fill"]')).toBeVisible({ timeout: 15000 });
    await expect(select).toBeFocused();
    await page.getByLabel("다시 조립").click();
    await expect(page.getByLabel("다시 조립")).toBeFocused();
    await expect(detail.locator('[data-slot="frame-loading"]')).toBeVisible();
    await expect(detail.locator('[data-slot="context-content-fill"]')).toBeVisible({ timeout: 15000 });
    await expect(page.getByLabel("다시 조립")).toBeFocused();
    await shot(page, `reassembled-${width}`);
    await setScene(page, "failure");
    await select.selectOption("claude");
    await expect(detail.getByRole("alert")).toBeVisible({ timeout: 15000 });
    await shot(page, `detail-failure-${width}`);
    await setScene(page, "normal");
    await detail.getByRole("button", { name: "다시 시도" }).click();
    await expect(detail.locator('[data-slot="context-content-fill"]')).toBeVisible({ timeout: 15000 });
  });

  test(`s6 filtered all and skill reload ${width}`, async ({ page }) => {
    await open(page, width, width === 360 ? 780 : 900, "loading");
    await expect(row(page, "조건부 지침")).toBeVisible({ timeout: 15000 });
    await page.getByLabel("조립 백엔드").selectOption("codex");
    await expect(row(page, "조건부 지침")).toBeVisible({ timeout: 15000 });
    await page.getByLabel("조립 카드 역할").selectOption("assignee");
    await expect(row(page, "조건부 지침")).not.toContainText("빠짐", { timeout: 15000 });
    await openBody(page, "조건부 지침");
    const detail = page.getByTestId("agent-context-assembly-detail");
    const role = page.getByLabel("조립 카드 역할"); await role.focus(); await role.selectOption("member");
    await expect(detail.locator('[data-slot="frame-loading"]')).toBeVisible();
    await expect(role).toBeFocused();
    await expect(detail).toContainText("이 조건에서는 빠집니다", { timeout: 15000 });
    await shot(page, `filtered-detail-${width}`);
    await page.getByLabel("소스 목록으로").click();
    await page.getByRole("button", { name: /^전체/ }).click();
    const source = page.getByLabel("조립 호출 소스"); await source.focus(); await source.selectOption("agent");
    await expect(detail).toContainText("전체");
    await expect(detail.locator('[data-slot="frame-loading"]')).toBeVisible();
    await expect(source).toBeFocused();
    await expect(detail.locator('[data-slot="context-content-fill"]')).toBeVisible({ timeout: 15000 });
    await shot(page, `all-reload-${width}`);
    await page.getByLabel("소스 목록으로").click();
    await openBody(page, "스킬 목록");
    await page.getByLabel("스킬 정의 원문").selectOption({ label: SKILL_LABEL });
    const skill = page.getByTestId("agent-context-skill-original");
    await expect(skill.locator('[data-slot="context-content-fill"]')).toBeVisible({ timeout: 15000 });
    const metadata = skill.locator("p").first();
    const metric = await metadata.evaluate(element => ({ width: element.clientWidth, scroll: element.scrollWidth }));
    expect(metric.scroll).toBeLessThanOrEqual(metric.width + 1);
    await page.getByLabel("다시 조립").click();
    await expect(skill.locator('[data-slot="frame-loading"]')).toBeVisible();
    await expect(page.getByLabel("다시 조립")).toBeFocused();
    await expect(skill.locator('[data-slot="context-content-fill"]')).toBeVisible({ timeout: 15000 });
    await shot(page, `skill-reload-${width}`);
  });
}

for (const [width, height] of [[1440, 900], [1920, 1080], [1024, 768], [768, 1024], [360, 780]]) {
  test(`s1 s3 s7 frame and wheel ${width}x${height}`, async ({ page }) => {
    await open(page, width, height);
    await expect(row(page, "스킬 목록")).toBeVisible();
    const frame = page.getByTestId("agent-profile-editor").locator("..");
    const detail = page.locator(".config-detail");
    if (width !== 360) expect(await detail.evaluate(element => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(1);
    if (width === 360) await detail.evaluate(element => { element.scrollTop = element.scrollHeight; });
    const measure = async () => {
      const boxes = await page.evaluate(() => {
        const d = document.querySelector('.config-detail')!; const g = document.querySelector('[data-testid="agent-profile-editor"]')!.parentElement!;
        const db = d.getBoundingClientRect(), gb = g.getBoundingClientRect();
        return { top: gb.top, bottom: gb.bottom, detailTop: db.top, detailBottom: db.bottom, scroll: d.scrollTop };
      });
      console.log(`frame ${width}x${height}: ${JSON.stringify(boxes)}`);
      expect(boxes.bottom).toBeLessThanOrEqual(boxes.detailBottom + 1);
      expect(boxes.top).toBeGreaterThanOrEqual(boxes.detailTop - 1);
    };
    await measure();
    const guidance = page.getByText("프로필 몫만 보입니다. 폴더, 페이지, 세션이 붙이는 글은 빠집니다.");
    await expect(guidance).toBeVisible();
    const guideBox = await guidance.boundingBox(), detailBox = await detail.boundingBox();
    expect(guideBox!.y + guideBox!.height).toBeLessThanOrEqual(detailBox!.y + detailBox!.height + 1);
    await shot(page, `frame-list-${width}x${height}`);
    await openBody(page, "공통 지침과 아주 긴 제목");
    const pre = page.locator('[data-slot="context-content-fill"]'); await expect(pre).toBeVisible();
    await measure();
    const preBox = await pre.boundingBox(), outerBox = await detail.boundingBox();
    expect(preBox!.y + preBox!.height).toBeLessThanOrEqual(outerBox!.y + outerBox!.height + 1);
    await shot(page, `frame-body-${width}x${height}`);
    await pre.evaluate(element => { element.scrollTop = element.scrollHeight; });
    const outerBefore = await detail.evaluate(element => element.scrollTop);
    await pre.hover(); await page.mouse.wheel(0, 700); await page.waitForTimeout(200);
    expect(await detail.evaluate(element => element.scrollTop)).toBe(outerBefore);
    await page.getByLabel("소스 목록으로").click();
    await openBody(page, "스킬 목록");
    await page.getByLabel("스킬 정의 원문").selectOption({ label: SKILL_LABEL });
    await expect(page.getByTestId("agent-context-skill-original")).toContainText("가상의 스킬 정의 원문");
    await measure(); await shot(page, `frame-skill-${width}x${height}`);
    await page.getByRole("tab", { name: "편집" }).click();
    await expect(frame).toBeVisible(); await measure(); await shot(page, `frame-edit-${width}x${height}`);
  });
}

for (const width of [360, 768, 1440]) {
  test(`s7 source metadata ${width}`, async ({ page }) => {
    await open(page, width, width === 360 ? 780 : 900);
    await openBody(page, "공통 지침과 아주 긴 제목");
    const metadata = page.getByTestId("agent-context-assembly-detail").locator("p").first();
    await expect(metadata).toContainText("토큰");
    const sizes = await metadata.evaluate(element => ({ width: element.clientWidth, scroll: element.scrollWidth, text: element.textContent }));
    console.log(`metadata ${width}: ${JSON.stringify(sizes)}`);
    expect(sizes.scroll).toBeLessThanOrEqual(sizes.width + 1);
    await shot(page, `metadata-${width}`);
  });
}

for (const width of [360, 768]) {
  test(`s5 source fields ${width}`, async ({ page }) => {
    await open(page, width, width === 360 ? 780 : 1024);
    await page.getByRole("tab", { name: "편집" }).click();
    const input = page.getByLabel("Atom node UUID").first(); await input.scrollIntoViewIfNeeded();
    const box = await input.boundingBox(); const parent = await input.locator("xpath=../../..").boundingBox();
    expect(box).not.toBeNull(); expect(parent).not.toBeNull();
    expect(box!.width).toBeGreaterThan(parent!.width * 0.8);
    const deleteBox = await page.getByRole("button", { name: "삭제", exact: true }).first().boundingBox();
    expect(deleteBox!.x + deleteBox!.width).toBeLessThanOrEqual(parent!.x + parent!.width + 1);
    const labels = await input.locator("xpath=../../..").evaluate(grid => {
      const items = Array.from(grid.querySelectorAll(":scope > label, :scope > div > label"));
      return items.map(item => { const box = item.getBoundingClientRect(); return { left: box.left, right: box.right, top: box.top, bottom: box.bottom }; });
    });
    expect(labels[0].bottom).toBeLessThanOrEqual(labels[1].top + 1);
    expect(labels[1].right).toBeLessThanOrEqual(labels[2].left + 1);
    await shot(page, `source-fields-${width}`);
  });
}

for (const width of [360, 768]) test(`s5 bundle editor ${width}`, async ({ page }) => {
  await open(page, width, width === 360 ? 780 : 1024);
  await page.getByRole("button", { name: "컨텍스트 번들 편집" }).click();
  await page.getByRole("button", { name: "공통 지침과 긴 이름을 가진 검수용 번들" }).click();
  const editor = page.getByTestId("context-bundle-editor");
  await expect(editor.getByLabel("번들 ID")).toBeVisible();
  if (width === 360) expect((await editor.boundingBox())!.width).toBeGreaterThan(200);
  await editor.getByLabel("설명").fill("수정 중인 설명");
  await expect(editor.getByLabel("설명")).toHaveValue("수정 중인 설명");
  const input = editor.getByLabel("Atom node UUID").first(); await input.scrollIntoViewIfNeeded();
  const box = await input.boundingBox(), grid = await input.locator("xpath=../../..").boundingBox();
  expect(box!.width).toBeGreaterThan(grid!.width * 0.8);
  await shot(page, `bundle-${width}`);
});

for (const [width, height] of [[1440, 900], [1920, 1080], [1024, 768], [768, 1024], [360, 780]]) {
  test(`s1 bundle frame ${width}x${height}`, async ({ page }) => {
    await open(page, width, height);
    await page.getByRole("button", { name: "컨텍스트 번들 편집" }).click();
    await page.getByRole("button", { name: "공통 지침과 긴 이름을 가진 검수용 번들" }).click();
    const detail = page.locator(".config-detail"), editor = page.getByTestId("context-bundle-editor");
    if (width !== 360) expect(await detail.evaluate(element => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(1);
    if (width === 360) await detail.evaluate(element => { element.scrollTop = element.scrollHeight; });
    const bounds = await editor.locator("..").boundingBox(), outer = await detail.boundingBox();
    expect(bounds!.y).toBeGreaterThanOrEqual(outer!.y - 1);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(outer!.y + outer!.height + 1);
    await editor.evaluate(element => { element.scrollTop = element.scrollHeight; });
    const before = await detail.evaluate(element => element.scrollTop);
    await editor.hover(); await page.mouse.wheel(0, 700); await page.waitForTimeout(200);
    expect(await detail.evaluate(element => element.scrollTop)).toBe(before);
    await shot(page, `bundle-frame-${width}x${height}`);
  });
}

test("s2 focus rings and s3 skill back label", async ({ page }) => {
  await open(page, 1440, 900); await expect(row(page, "스킬 목록")).toBeVisible();
  await page.getByLabel("실행 노드").focus();
  const tabOrder: string[] = [];
  for (let index = 0; index < 22; index++) {
    await page.keyboard.press("Tab");
    const focused = page.locator(":focus");
    await expect(focused).toBeVisible();
    tabOrder.push(await focused.evaluate(element => element.getAttribute("aria-label") || (element.textContent ?? "").trim()));
  }
  console.log(`tab order: ${JSON.stringify(tabOrder)}`);
  const first = row(page, "스킬 목록"); await first.focus();
  const focused = await first.evaluate(element => ({ outline: getComputedStyle(element).outlineStyle, shadow: getComputedStyle(element).boxShadow }));
  expect(focused.shadow).not.toBe("none");
  await page.getByLabel("조립 백엔드").focus();
  expect(await page.getByLabel("조립 백엔드").evaluate(element => getComputedStyle(element).boxShadow)).not.toBe("none");
  await openBody(page, "스킬 목록"); await page.getByLabel("소스 목록으로").click();
  await expect(first).toBeFocused();
  expect(await first.evaluate(element => getComputedStyle(element).boxShadow)).toBe("none");
  await openBody(page, "스킬 목록"); await page.getByLabel("스킬 정의 원문").selectOption({ label: SKILL_LABEL });
  const back = page.getByRole("button", { name: "소스 본문으로" });
  await expect(back).toBeVisible(); await expect(back).toHaveAttribute("title", "소스 본문으로"); await shot(page, "focus-and-skill-back");
});

for (const width of [1440, 360]) {
  for (const section of ["화면과 읽기", "파일 저장소", "카드 실행"]) test(`s4 other settings scroll ${section} ${width}`, async ({ page }) => {
    await open(page, width, width === 360 ? 780 : 900, "normal", section);
    const detail = page.locator(".config-detail");
    const sizes = await detail.evaluate(element => ({ scrollHeight: element.scrollHeight, clientHeight: element.clientHeight }));
    expect(await detail.evaluate(element => getComputedStyle(element).overflowY)).toBe("auto");
    if (sizes.scrollHeight > sizes.clientHeight) {
      await detail.evaluate(element => { element.scrollTop = element.scrollHeight; });
      expect(await detail.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    }
    await shot(page, `other-settings-${section.replaceAll(" ", "-")}-${width}`);
  });
}
