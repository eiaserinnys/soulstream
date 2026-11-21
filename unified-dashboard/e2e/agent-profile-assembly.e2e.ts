import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { installV3VisualQaRoutes } from "./v3-visual-fixtures";
import { assemblyBundles, assemblyContexts, assemblyPreview } from "../client/v3/agent-profile-assembly-fixture";

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
    return route.fallback();
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
async function chooseProfile(page: Page, width: number, name: string, value: string) {
  if (width < 640) await page.getByLabel("프로필", { exact: true }).selectOption(value);
  else await page.locator("aside button").filter({ hasText: name }).click();
}

if (process.env.ASSEMBLY_BASELINE === "1") test("baseline shows the new assembly view", async ({ page }) => {
  await open(page, 1440);
  await capture(page, 1440, "before");
  await page.setViewportSize({ width: 360, height: 900 });
  await capture(page, 360, "before");
  await expect(page.getByTestId("agent-context-assembly")).toBeVisible({ timeout: 3000 });
});

for (const width of [1440, 360]) {
  test(`assembly states and interaction ${width}`, async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await open(page, width);
    await expect(page.getByTestId("agent-context-assembly")).toContainText("공통 지침");
    await capture(page, width, "normal");
    await expect(page.getByTestId("agent-context-assembly")).toContainText("실패");
    await expect(page.getByTestId("agent-context-assembly")).toContainText("빠짐");
    await capture(page, width, "source-failure");
    const titleBounds = await page.getByTestId("agent-context-assembly").locator("button").filter({ hasText: "공통 지침과 아주 긴 제목" }).evaluate(element => {
      const row = element.getBoundingClientRect();
      const title = element.querySelector(".truncate")!.getBoundingClientRect();
      return { rowLeft: row.left, rowRight: row.right, titleLeft: title.left, titleRight: title.right, titleWidth: title.width };
    });
    expect(titleBounds.titleLeft).toBeGreaterThanOrEqual(titleBounds.rowLeft);
    expect(titleBounds.titleRight).toBeLessThanOrEqual(titleBounds.rowRight);
    expect(titleBounds.titleWidth).toBeGreaterThan(40);
    await page.getByLabel("조립 백엔드").selectOption("codex");
    await page.getByLabel("조립 카드 역할").selectOption("assignee");
    await expect(page.getByTestId("agent-context-assembly")).toContainText("조건부 지침");
    await capture(page, width, "conditions");
    await page.getByTestId("agent-context-assembly").locator("button").filter({ hasText: "공통 지침과 아주 긴 제목" }).click();
    const content = page.locator('[data-slot="context-content-fill"]');
    await expect(content).toBeVisible();
    expect((await content.textContent())!.length).toBeGreaterThan(50000);
    await capture(page, width, "long-body");
    await content.evaluate(element => { element.scrollTop = 300; });
    const scrollBefore = await content.evaluate(element => element.scrollTop);
    await page.setViewportSize({ width: width === 1440 ? 360 : 1440, height: 900 });
    expect(await content.evaluate(element => element.scrollTop)).toBe(scrollBefore);
    await page.setViewportSize({ width, height: 900 });
    await page.getByLabel("소스 목록으로").click();
    await page.getByTestId("agent-context-assembly").locator("button").filter({ hasText: "스킬 목록" }).click();
    await page.getByLabel("스킬 정의 원문").selectOption({ label: "검수 스킬" });
    await expect(page.getByTestId("agent-context-skill-original")).toContainText("가상의 스킬 정의 원문");
    await capture(page, width, "skill");
    await page.getByLabel("스킬 목록로").click();
    await expect(page.getByLabel("스킬 정의 원문")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.locator(":focus")).toBeVisible();
    await expect(page.getByTestId("agent-context-assembly-detail")).toBeVisible();
    await capture(page, width, "skill-focus");
    await page.getByLabel("소스 목록으로").click();
    await page.getByRole("button", { name: /^전체/ }).click();
    await page.getByLabel("전체 복사").click();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toBe(assemblyPreview({ atom_contexts: [...assemblyBundles.flatMap(bundle => bundle.atom_contexts), ...assemblyContexts], session: { backend: "codex", card_role: "assignee" } }).assembled);
    await page.getByLabel("소스 목록으로").click();
    await page.getByRole("tab", { name: "편집" }).click();
    await page.getByLabel("공통 지침과 긴 이름을 가진 검수용 번들 제거").click();
    await page.getByRole("tab", { name: "조립" }).click();
    await page.getByLabel("다시 조립").click();
    await expect(page.getByTestId("agent-context-assembly")).not.toContainText("스킬 목록");
    await capture(page, width, "draft");
    await page.getByRole("tab", { name: "편집" }).click();
    await page.getByRole("button", { name: "프로필 저장" }).click();
    await expect(page.getByRole("status")).toContainText("프로필을 저장했습니다");
    await page.getByRole("tab", { name: "조립" }).click();
    await capture(page, width, "saved");
    await chooseProfile(page, width, "노드 전용 검수 프로필", "node:node-sample");
    await expect(page.getByRole("tab", { name: "편집" })).toBeDisabled();
    await expect(page.getByTestId("agent-context-assembly")).toContainText("노드 설정");
    await capture(page, width, "node-only");
    await chooseProfile(page, width, "소스 없는 프로필", "central:empty-sample");
    await expect(page.getByTestId("agent-context-assembly")).toContainText("전체");
    await capture(page, width, "empty-profile");
    await chooseProfile(page, width, "검수 프로필", "central:roselin");
    await page.getByLabel("실행 노드").selectOption("sample-usage-node");
    await expect(page.getByText(/에는 이 프로필이 없습니다/)).toBeVisible();
    await capture(page, width, "missing-profile");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    expect(overflow).toBe(false);
    await page.getByRole("tab", { name: "편집" }).click();
    const name = page.getByLabel("이름", { exact: true });
    await name.fill("수정 중인 이름");
    await page.setViewportSize({ width: width === 1440 ? 360 : 1440, height: 900 });
    await expect(name).toHaveValue("수정 중인 이름");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();
  });

  test(`loading, retry and disconnected ${width}`, async ({ page }) => {
    await open(page, width, "loading");
    await expect(page.getByLabel(/조립하는 중/).first()).toBeVisible();
    await capture(page, width, "loading");
    await page.goto("about:blank");
    await open(page, width, "retry");
    await expect(page.getByRole("alert")).toContainText("노드에 연결하지 못했습니다");
    await capture(page, width, "request-failure");
    await page.getByRole("button", { name: "다시 시도" }).click();
    await expect(page.getByTestId("agent-context-assembly")).toContainText("스킬 목록");
    await capture(page, width, "retry");
    await page.goto("about:blank");
    await open(page, width, "no-nodes");
    await expect(page.getByText("연결된 노드가 없습니다.")).toBeVisible();
    await capture(page, width, "no-nodes");
  });
}
