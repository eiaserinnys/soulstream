import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { openBody } from "./agent-profile-assembly-guides-helpers";
import { guideSkills } from "../client/v3/guides-fixture";
import { installV3VisualQaRoutes } from "./v3-visual-fixtures";
import { assemblyBundles, assemblyContexts, assemblyPreview } from "../client/v3/agent-profile-assembly-fixture";

const SKILL_LABEL = guideSkills[1]!.name;
const output = path.resolve("../.local/card1783-captures");
async function open(page: Page, width: number, state = "normal") {
  await page.setViewportSize({ width, height: 900 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.addInitScript(() => { localStorage.setItem("soul-dashboard-theme", "dark"); localStorage.setItem("ls.webglGlass", "0"); });
  await installV3VisualQaRoutes(page);
  await page.route("**/api/**", route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/api/auth/config") return route.fulfill({ json: { authEnabled: true, devModeEnabled: false } });
    if (pathname === "/api/auth/status") return route.fulfill({ json: { authenticated: true, user: { email: "qa@example.test", name: "QA", isAdmin: true } } });
    if (pathname === "/api/ui-events/config") return route.fulfill({ json: { enabled: true, flushIntervalMs: 1000, maxBatchSize: 1, maxQueueSize: 500, schemaVersion: "soulstream.ui_event.v1" } });
    if (pathname === "/api/health") return route.fulfill({ json: { healthy: true, ready: true, draining: false, build_id: "dev" } });
    if (pathname === "/api/nodes") return route.fulfill({ json: { nodes: [] } });
    if (pathname === "/api/nodes/stream") return route.fulfill({ status: 200, contentType: "text/event-stream", body: "event: snapshot\ndata: []\n\n" });
    if (pathname === "/api/sessions/stream") return route.fulfill({ status: 200, contentType: "text/event-stream", body: 'event: session_list\ndata: {"type":"session_list","sessions":[],"total":0}\n\n' });
    if (pathname.endsWith("/stream") || pathname.endsWith("/events")) return route.fulfill({ status: 200, contentType: "text/event-stream", body: ": empty\n\n" });
    return route.fulfill({ status: 200, json: {} });
  });
  await page.goto(`/dialogues?sample=settings&assemblyState=${state}`);
  await expect(page.getByRole("dialog")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "에이전트", exact: true }).click();
  await expect(page.getByTestId("agent-profile-editor")).toBeVisible();
}
async function capture(page: Page, width: number, name: string) {
  mkdirSync(output, { recursive: true });
  await page.screenshot({ path: path.join(output, `${name}-${width}.png`), animations: "disabled" });
}
function record(width: number, name: string, value: unknown) {
  mkdirSync(output, { recursive: true });
  writeFileSync(path.join(output, `${name}-${width}.json`), JSON.stringify(value, null, 2));
  console.log(`${name}-${width}: ${JSON.stringify(value)}`);
}
async function chooseProfile(page: Page, width: number, name: string, value: string) {
  if (width < 640) await page.getByLabel("프로필", { exact: true }).selectOption(value);
  else await page.locator("aside button").filter({ hasText: name }).click();
}
const row = (page: Page, title: string) => page.getByTestId("agent-context-assembly").locator("button").filter({ hasText: title });
async function headerPixels(page: Page, before: Buffer, after: Buffer) {
  const box = await page.getByRole("heading", { name: "설정", exact: true }).boundingBox();
  if (!box) throw new Error("설정 머리 위치를 찾지 못했습니다.");
  return page.evaluate(async ({ first, second, rect }) => {
    const read = (src: string) => new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image(); image.onload = () => resolve(image); image.onerror = reject; image.src = src;
    });
    const images = await Promise.all([read(first), read(second)]);
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(rect.width); canvas.height = Math.ceil(rect.height);
    const context = canvas.getContext("2d")!;
    const pixels = images.map(image => {
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, Math.floor(rect.x), Math.floor(rect.y), canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
      return context.getImageData(0, 0, canvas.width, canvas.height).data;
    });
    let changed = 0;
    for (let i = 0; i < pixels[0].length; i += 4) {
      if ([0, 1, 2, 3].some(offset => pixels[0][i + offset] !== pixels[1][i + offset])) changed++;
    }
    return { rect, changed, pixels: canvas.width * canvas.height };
  }, { first: `data:image/png;base64,${before.toString("base64")}`, second: `data:image/png;base64,${after.toString("base64")}`, rect: box });
}

test.afterEach(async ({ page }, info) => {
  if (info.status !== info.expectedStatus) {
    mkdirSync(output, { recursive: true });
    await page.screenshot({ path: path.join(output, `failed-${info.title.replace(/[^a-z0-9-]+/gi, "-")}.png`), animations: "disabled" }).catch(() => {});
  }
});

if (process.env.ASSEMBLY_BASELINE === "1") test("baseline shows the new assembly view", async ({ page }) => {
  await open(page, 1440); await capture(page, 1440, "before");
  await page.setViewportSize({ width: 360, height: 900 }); await capture(page, 360, "before");
  await expect(page.getByTestId("agent-context-assembly")).toBeVisible({ timeout: 3000 });
});

for (const width of [1440, 360]) {
  test(`normal and conditions ${width}`, async ({ page }) => {
    await open(page, width);
    await expect(row(page, "공통 지침과 아주 긴 제목")).toBeVisible();
    await expect(row(page, "실패 소스")).toContainText("실패");
    await expect(row(page, "조건부 지침")).toContainText("빠짐");
    await capture(page, width, "normal"); await capture(page, width, "source-failure");
    const geometry = await page.evaluate(() => {
      const rect = (element: Element) => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right }; };
      const editor = document.querySelector('[data-testid="agent-profile-editor"]')!;
      const node = document.querySelector('[aria-label="실행 노드"]')!;
      const grid = editor.parentElement!;
      const title = Array.from(document.querySelectorAll('[data-testid="agent-context-assembly"] button')).find(button => button.textContent?.includes("공통 지침과 아주 긴 제목"))!;
      const action = document.querySelector('[aria-label="다시 조립"]')!;
      return { node: rect(node), grid: rect(grid), titleRow: rect(title), title: rect(title.querySelector(".truncate")!), action: rect(action), documentWidth: document.documentElement.scrollWidth, viewportWidth: document.documentElement.clientWidth };
    });
    record(width, "geometry", geometry);
    expect(Math.abs(geometry.node.x - geometry.grid.x)).toBeLessThanOrEqual(1);
    expect(geometry.title.x).toBeGreaterThanOrEqual(geometry.titleRow.x);
    expect(geometry.title.right).toBeLessThanOrEqual(geometry.titleRow.right);
    expect(geometry.title.width).toBeGreaterThan(40);
    expect(geometry.action.width).toBeGreaterThanOrEqual(24);
    expect(geometry.action.height).toBeGreaterThanOrEqual(24);
    expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.viewportWidth);
    const before = await page.screenshot({ animations: "disabled" });
    await page.getByLabel("조립 백엔드").selectOption("codex");
    await page.getByLabel("조립 카드 역할").selectOption("assignee");
    await expect(row(page, "조건부 지침")).not.toContainText("빠짐");
    await capture(page, width, "conditions");
    const after = await page.screenshot({ animations: "disabled" });
    const comparison = await headerPixels(page, before, after);
    record(width, "unchanged-header", comparison);
    expect(comparison.changed).toBe(0);
  });

  test(`long body and scroll ${width}`, async ({ page }) => {
    await open(page, width); await openBody(page, "공통 지침과 아주 긴 제목");
    const content = page.locator('[data-slot="context-content-fill"]');
    await expect(content).toBeVisible();
    expect((await content.textContent())!.length).toBeGreaterThan(50000);
    await capture(page, width, "long-body");
    const metrics = await content.evaluate(element => {
      const outer = document.querySelector(".config-detail")!;
      const initialOuter = outer.scrollTop;
      const initialDocument = document.documentElement.scrollTop;
      element.scrollTop = 300;
      return { contentHeight: element.clientHeight, contentScrollHeight: element.scrollHeight, contentWidth: element.clientWidth, contentScrollWidth: element.scrollWidth, contentScrollTop: element.scrollTop, outerBefore: initialOuter, outerAfter: outer.scrollTop, documentBefore: initialDocument, documentAfter: document.documentElement.scrollTop, documentWidth: document.documentElement.scrollWidth, viewportWidth: document.documentElement.clientWidth };
    });
    record(width, "long-body-scroll", metrics);
    expect(metrics.contentScrollHeight).toBeGreaterThan(metrics.contentHeight);
    expect(metrics.contentScrollTop).toBeGreaterThan(0);
    expect(metrics.contentScrollWidth).toBeLessThanOrEqual(metrics.contentWidth);
    expect(metrics.documentWidth).toBeLessThanOrEqual(metrics.viewportWidth);
    expect(metrics.outerAfter).toBe(metrics.outerBefore);
    expect(metrics.documentAfter).toBe(metrics.documentBefore);
    await page.setViewportSize({ width: width === 1440 ? 360 : 1440, height: 900 });
    expect(await content.evaluate(element => element.scrollTop)).toBe(metrics.contentScrollTop);
  });

  test(`skill focus and copy ${width}`, async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await open(page, width);
    await page.getByLabel("조립 백엔드").selectOption("codex");
    await page.getByLabel("조립 카드 역할").selectOption("assignee");
    await expect(row(page, "조건부 지침")).not.toContainText("빠짐");
    await openBody(page, "스킬 목록");
    await page.getByLabel("스킬 정의 원문").selectOption({ label: SKILL_LABEL });
    await expect(page.getByTestId("agent-context-skill-original")).toContainText("가상의 스킬 정의 원문");
    await capture(page, width, "skill");
    await page.getByLabel("소스 본문으로").click();
    await expect(page.getByLabel("스킬 정의 원문")).toBeFocused();
    await capture(page, width, "skill-focus");
    await page.keyboard.press("Tab"); await expect(page.locator(":focus")).toBeVisible();
    const focused = await page.locator(":focus").evaluate(element => ({ tag: element.tagName, label: element.getAttribute("aria-label"), text: element.textContent }));
    record(width, "tab-focus", focused);
    await page.getByLabel("소스 목록으로").click();
    await page.getByRole("button", { name: /^전체/ }).click();
    await page.getByLabel("전체 복사").click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(assemblyPreview({ atom_contexts: [...assemblyBundles.flatMap(bundle => bundle.atom_contexts), ...assemblyContexts], session: { backend: "codex", card_role: "assignee" } }).assembled);
  });

  test(`draft and saved ${width}`, async ({ page }) => {
    await open(page, width); await page.getByRole("tab", { name: "편집" }).click();
    await page.getByLabel("공통 지침과 긴 이름을 가진 검수용 번들 제거").click();
    await page.getByRole("tab", { name: "구성" }).click();
    await page.getByLabel("다시 조립").click();
    await expect(page.getByTestId("agent-context-assembly")).not.toContainText("스킬 목록");
    await capture(page, width, "draft");
    await page.getByRole("tab", { name: "편집" }).click();
    await page.getByRole("button", { name: "프로필 저장" }).click();
    await expect(page.getByTestId("agent-profile-editor").getByRole("status")).toHaveText("프로필을 저장했습니다.");
    await page.getByRole("tab", { name: "구성" }).click();
    await expect(page.getByTestId("agent-context-assembly")).not.toContainText("스킬 목록");
    await capture(page, width, "saved");
  });

  test(`node-only profile ${width}`, async ({ page }) => {
    await open(page, width); await chooseProfile(page, width, "노드 전용 검수 프로필", "node:node-sample");
    await expect(page.getByRole("tab", { name: "편집" })).toBeDisabled();
    await expect(page.getByTestId("agent-context-assembly")).toContainText("노드 설정");
    await expect(page.getByLabel("다시 조립")).toHaveCount(0);
    await capture(page, width, "node-only");
  });

  test(`empty profile ${width}`, async ({ page }) => {
    await open(page, width); await chooseProfile(page, width, "소스 없는 프로필", "central:empty-sample");
    await expect(page.getByTestId("agent-context-assembly")).toContainText("전체");
    await expect(page.getByTestId("agent-context-assembly")).not.toContainText("스킬 목록");
    await capture(page, width, "empty-profile");
  });

  test(`missing profile ${width}`, async ({ page }) => {
    await open(page, width); await page.getByLabel("실행 노드").selectOption("sample-usage-node");
    await expect(page.getByText(/에는 이 프로필이 없습니다/)).toBeVisible();
    await expect(row(page, "스킬 목록")).toBeVisible();
    await capture(page, width, "missing-profile");
  });

  test(`request failure and retry ${width}`, async ({ page }) => {
    await open(page, width, "retry");
    await expect(page.getByTestId("agent-context-assembly").getByRole("alert")).toContainText("노드에 연결하지 못했습니다");
    await capture(page, width, "request-failure");
    await page.evaluate(() => { const url = new URL(location.href); url.searchParams.set("assemblyState", "normal"); history.replaceState(null, "", url); });
    await page.getByRole("button", { name: "다시 시도" }).click();
    await expect(row(page, "스킬 목록")).toBeVisible();
    await capture(page, width, "request-retry");
  });

  test(`loading ${width}`, async ({ page }) => {
    await open(page, width, "loading");
    await expect(page.getByLabel(/조립하는 중/).first()).toBeVisible();
    await capture(page, width, "loading");
  });

  test(`no connected nodes ${width}`, async ({ page }) => {
    await open(page, width, "no-nodes");
    await expect(page.getByText("연결된 노드가 없습니다.")).toBeVisible();
    await capture(page, width, "no-nodes");
  });

  test(`resize draft and escape ${width}`, async ({ page }) => {
    await open(page, width); await page.getByRole("tab", { name: "편집" }).click();
    const name = page.getByLabel("이름", { exact: true });
    await name.fill("수정 중인 이름");
    await page.setViewportSize({ width: width === 1440 ? 360 : 1440, height: 900 });
    await expect(name).toHaveValue("수정 중인 이름");
    await capture(page, width, "resize-draft");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();
    await capture(page, width, "escape");
  });
}
