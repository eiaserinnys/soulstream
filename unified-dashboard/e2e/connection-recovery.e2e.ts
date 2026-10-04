import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { installV3VisualQaRoutes } from "./v3-visual-fixtures";
import type { CardRow } from "../../packages/soul-ui/src/cards/card-types";
const output = resolve("../.local/connection-recovery");
mkdirSync(output, { recursive: true });
const control = "http://127.0.0.1:52107";
const card: CardRow = {
  id: "connection-card",
  folderId: "folder-amber",
  title: "연결 복구 확인",
  request: "원래 요청",
  brief: "현재 경과",
  status: "review",
  blockedKind: null,
  blockedDetail: null,
  positionKey: "a",
  queuePositionKey: null,
  assigneeKind: "agent",
  assigneeAgentId: "roselin_codex",
  assigneeUserId: null,
  assigneeSessionId: null,
  nodeId: "eiaserinnys",
  modelPreset: "qa-standard",
  version: 1,
  archived: false,
  createdAt: "2026-10-04T00:00:00Z",
  updatedAt: "2026-10-04T00:00:00Z",
};
async function setup(page: Page) {
  await page
    .context()
    .addCookies([
      {
        name: "connection-qa",
        value: "authenticated",
        url: "http://127.0.0.1:52108",
      },
    ]);
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.addInitScript(() => {
    localStorage.setItem("soul-dashboard-theme", "dark");
    localStorage.setItem("ls.webglGlass", "0");
    localStorage.setItem(
      "cards-p1-handoff",
      JSON.stringify({
        folderId: "folder-amber",
        nodeId: "eiaserinnys",
        agentId: "roselin_codex",
        modelPreset: "qa-standard",
      }),
    );
    Object.defineProperty(navigator.serviceWorker, "register", {
      configurable: true,
      value: async () => ({
        update: async () => undefined,
        active: null,
        addEventListener: () => undefined,
      }),
    });
    Object.defineProperty(navigator.serviceWorker, "controller", {
      configurable: true,
      get: () => null,
    });
  });
  await installV3VisualQaRoutes(page, {
    unifiedFolderView: true,
    postitCards: [card],
  });
  await page.route("**/api/sessions/stream*", (route) => route.continue());
  await page.route("**/api/health", (route) => route.continue());
  let offline = false;
  await page.route("**/api/**", route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/health" || path === "/api/sessions/stream") return route.continue();
    if (offline) return route.fulfill({status:503,contentType:"application/json",body:'{"error":"isolated deployment fixture offline"}'});
    return route.fallback();
  });
  let cardReads = 0;
  await page.route("**/api/cards/connection-card", (route) => {
    cardReads++;
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        card,
        reports: [],
        questions: [],
        sessions: [],
        comments: [
          {
            id: `read-${cardReads}`,
            cardId: card.id,
            authorKind: "user",
            authorId: "qa",
            sessionId: null,
            kind: "comment",
            body: `서버 상세 조회 ${cardReads}`,
            createdAt: "2026-10-04T00:00:00Z",
          },
        ],
      }),
    });
  });
  return { cardReads: () => cardReads, setOffline: (value: boolean) => { offline = value; } };
}
test.beforeEach(async ({ request }) => {
  await request.post(control + "/close");
  await request.post(control + "/start");
});
for (const width of [1440, 390])
  test(`real production close and same build recovery ${width}`, async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
    const fixture = await setup(page);
    await page.goto("/v3");
    const mainDraft = page.getByRole("textbox", { name: "세션 첫 메시지" });
    await expect(mainDraft).toBeVisible();
    await mainDraft.fill("전송 전 초안 유지");
    await page
      .getByRole("button", { name: "카드 연결 복구 확인 열기" })
      .click();
    const detail = page.getByTestId("card-detail");
    await expect(detail).toBeVisible();
    const input = detail.locator("textarea");
    await input.fill("카드 커멘트 초안 유지");
    await input.focus();
    const initialReads = fixture.cardReads();
    await page.screenshot({
      path: `${output}/normal-${width}.png`,
      animations: "disabled",
    });
    await request.post(control + "/close");
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("heading")).toHaveText(
      "소울스트림 오케스트레이터와의 연결이 끊겼습니다",
    );
    const heading = dialog.getByRole("heading");
    await expect(heading).toBeFocused();
    await page.keyboard.press("Escape");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    await page.mouse.click(4, 4);
    await expect(dialog).toBeVisible();
    await expect(heading).toBeFocused();
    await expect(input).toHaveValue("카드 커멘트 초안 유지");
    await page.screenshot({
      path: `${output}/disconnected-${width}.png`,
      animations: "disabled",
    });
    const rectangle = await dialog.boundingBox();
    expect(rectangle?.width).toBeLessThanOrEqual(384);
    expect(rectangle?.x).toBeGreaterThanOrEqual(16);
    await request.post(control + "/start");
    await expect(dialog).toBeHidden({ timeout: 20000 });
    await expect.poll(fixture.cardReads).toBeGreaterThan(initialReads);
    await expect(input).toHaveValue("카드 커멘트 초안 유지");
    await expect(input).toBeFocused();
    await expect(detail).toContainText(`서버 상세 조회 ${fixture.cardReads()}`);
    await page.screenshot({
      path: `${output}/recovered-${width}.png`,
      animations: "disabled",
    });
    await detail.getByRole("button", { name: "카드 닫기" }).click();
    await expect(mainDraft).toHaveValue("전송 전 초안 유지");
    const evidence = await (await request.get(control + "/evidence")).json();
    writeFileSync(
      `${output}/server-${width}.json`,
      JSON.stringify(
        { evidence, cardReads: fixture.cardReads(), rectangle },
        null,
        2,
      ),
    );
  });
test("fresh nginx fallback keeps document URI and leaves APIs failing", async ({
  page,
  request,
}) => {
  const fixture = await setup(page);
  fixture.setOffline(true);
  await request.post(control + "/close");
  const api = await request.get("/api/health");
  expect(api.status()).toBe(502);
  expect(api.headers()["content-type"]).not.toContain("application/json");
  const response = await page.goto("/v3?connection=fresh");
  expect(response?.status()).toBe(200);
  await expect(page.getByRole("dialog")).toContainText(
    "자동으로 다시 연결하고 있습니다",
  );
  await expect(page.getByRole("dialog")).toContainText(
    "연결이 돌아오면 자동으로 화면을 엽니다.",
  );
  expect(page.url()).toContain("/v3?connection=fresh");
  fixture.setOffline(false);
  await request.post(control + "/start");
  await expect(page.getByRole("dialog")).toBeHidden({ timeout: 20000 });
  await expect(
    page.getByRole("textbox", { name: "세션 첫 메시지" }),
  ).toBeVisible();
});
test("new build automatically reloads and restores the persisted text draft", async ({
  page,
  request,
}) => {
  await setup(page);
  await page.goto("/v3");
  const input = page.getByRole("textbox", { name: "세션 첫 메시지" });
  await input.fill("새 버전 이후 텍스트 초안");
  let reloads = 0;
  await page.route("**/v3", async (route) => {
    if (route.request().isNavigationRequest()) {
      reloads++;
      await request.post(control + "/close");
      await request.post(control + "/start");
    }
    await route.continue();
  });
  await request.post(control + "/close");
  await expect(page.getByRole("dialog")).toBeVisible();
  await request.post(control + "/start", { data: { newBuild: true } });
  await expect.poll(() => reloads, { timeout: 20000 }).toBe(1);
  await expect(input).toHaveValue("새 버전 이후 텍스트 초안");
  await expect(page.getByRole("dialog")).toBeHidden();
  expect(
    await page.evaluate(() =>
      performance
        .getEntriesByType("navigation")
        .map((item) => (item as PerformanceNavigationTiming).type),
    ),
  ).toContain("reload");
});
test("selected uploaded attachment defers a new build and releases the screen", async ({
  page,
  request,
}) => {
  await setup(page);
  await page.goto("/v3");
  const input = page.getByRole("textbox", { name: "세션 첫 메시지" });
  await input.fill("첨부를 마무리할 초안");
  await page.route("**/api/attachments/sessions?*", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ path: "qa/keep.txt" }),
    }),
  );
  await page
    .locator('.v3-today-handoff input[type="file"]')
    .setInputFiles({
      name: "keep.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("keep attachment"),
    });
  await expect(page.locator(".v3-today-handoff")).toContainText("keep.txt");
  await request.post(control + "/close");
  await expect(page.getByRole("dialog")).toBeVisible();
  await request.post(control + "/start", { data: { newBuild: true } });
  await expect(page.getByRole("dialog")).toBeHidden({ timeout: 20000 });
  await expect(page.locator("[data-sw-update-banner]")).toContainText(
    "작성 중인 내용을 확인한 뒤 새로고침합니다",
  );
  await expect(input).toHaveValue("첨부를 마무리할 초안");
  await input.fill("첨부 전송/삭제를 계속할 수 있습니다");
  await expect(page.locator(".v3-today-handoff")).toContainText("keep.txt");
  await page.screenshot({
    path: `${output}/attachment-deferred.png`,
    animations: "disabled",
  });
});
