import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { installReadmeDemoRoutes, readmeDemoIds, type DemoFixtureDiagnostics } from "./demo-fixtures";

const screenshots = resolve(dirname(fileURLToPath(import.meta.url)), "../../../docs/screenshots");
const baseURL = "http://127.0.0.1:4174";
const runs = new WeakMap<Page, { label: string; diagnostics: DemoFixtureDiagnostics; pageErrors: string[] }>();

async function prepare(page: Page, label: string, path: string) {
  const diagnostics: DemoFixtureDiagnostics = { registeredApi: [], unregisteredApi: [] };
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
    console.error(`[readme-demo:page-error] ${error.message}`);
  });
  runs.set(page, { label, diagnostics, pageErrors });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        register: async () => ({
          update: async () => undefined,
          active: null,
          installing: null,
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
        }),
        controller: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      },
    });
  });
  await installReadmeDemoRoutes(page, diagnostics);
  await page.goto(path, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => Boolean(document.querySelector(".v3-shell, .persistent-session-screen")), null, { timeout: 90_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(700);
  return { diagnostics, pageErrors };
}

async function expectSettled(page: Page) {
  const statusText = (await page.locator('[role="status"]:visible').allTextContents()).join("\n");
  const visibleText = await page.locator("body").innerText();
  expect(statusText).not.toMatch(/불러오는 중|시작 중|가져오는 중|수집 중|오류|실패|불러오지 못/i);
  expect(visibleText).not.toMatch(/불러오는 중|시작 중|가져오는 중|수집 중|불러오지 못/i);
  await expect(page.locator('[role="alert"]:visible')).toHaveCount(0);
  await expect(page.locator(".v3-toast.is-visible:visible")).toHaveCount(0);
}

async function settleAndCapture(page: Page, path: string) {
  await page.evaluate(async () => {
    document.activeElement instanceof HTMLElement && document.activeElement.blur();
    await document.fonts.ready;
    for (const animation of document.getAnimations()) animation.pause();
  });
  await page.addStyleTag({ content: "*, *::before, *::after { animation-duration: 0s !important; transition-duration: 0s !important; scroll-behavior: auto !important; caret-color: transparent !important; }" });
  await page.mouse.move(-10, -10);
  await page.waitForTimeout(150);
  await page.screenshot({ path, type: "png", animations: "disabled" });
}

function report(label: string, diagnostics: DemoFixtureDiagnostics, pageErrors: string[]) {
  console.log(`[readme-demo:${label}] registered API: ${JSON.stringify([...new Set(diagnostics.registeredApi)])}`);
  console.log(`[readme-demo:${label}] unregistered API: ${JSON.stringify([...new Set(diagnostics.unregisteredApi)])}`);
  console.log(`[readme-demo:${label}] page errors: ${JSON.stringify(pageErrors)}`);
}

test.afterEach(async ({ page }) => {
  const run = runs.get(page);
  if (run) report(run.label, run.diagnostics, run.pageErrors);
});

async function capturePersistentSession(browser: Browser) {
  const context = await browser.newContext({
    baseURL,
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    serviceWorkers: "block",
  });
  const page = await context.newPage();
  let diagnostics: DemoFixtureDiagnostics = { registeredApi: [], unregisteredApi: [] };
  let pageErrors: string[] = [];
  try {
    ({ diagnostics, pageErrors } = await prepare(page, "mobile", `/persistent/${readmeDemoIds.sessionIds.persistent}`));
    await expect(page.getByTestId("persistent-session-screen")).toBeVisible();
    await expect(page.getByText("오늘 끝난 것 정리해 줘", { exact: true })).toBeVisible();
    await expect(page.locator(".pas-report")).toBeVisible();
    const layout = await page.evaluate(() => ({
      width: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      mobile: window.matchMedia("(max-width: 760px)").matches,
      hasChat: Boolean(document.querySelector(".persistent-session-main")),
    }));
    if (!layout.mobile || layout.scrollWidth > layout.width || !layout.hasChat) {
      console.log(`[readme-demo:mobile] 캡처 생략: ${JSON.stringify(layout)}`);
    } else {
      await expectSettled(page);
      await mkdir(screenshots, { recursive: true });
      await settleAndCapture(page, resolve(screenshots, "mobile.png"));
    }
    expect(pageErrors).toEqual([]);
  } finally {
    report("mobile", diagnostics, pageErrors);
    await context.close();
  }
}

test("대시보드에 폴더, 카드와 실행 중 채팅을 함께 캡처한다", async ({ page }) => {
  const { pageErrors } = await prepare(page, "dashboard", `/?folder=${readmeDemoIds.folderId}`);
  const runningRow = page.getByTestId(`v3-session-row-${readmeDemoIds.sessionIds.running}`);
  await expect(runningRow).toBeVisible();
  await runningRow.locator(".v3-run-open").click();
  await expect(page.getByTestId("v3-standalone-session-chat")).toBeVisible();
  const cards = page.getByTestId("v3-folder-cards-section");
  await expect(cards).toContainText("위젯에 시간대별 강수 확률 넣기");
  await expect(cards).toContainText("오프라인에서 마지막 예보 보여 주기");
  await expect(page.locator(".v3-chat-pane")).toContainText("위젯 폭에 맞춰 두 시간대씩 묶어 표시했습니다.");
  await cards.scrollIntoViewIfNeeded();
  await expect(page.getByText("📱 Aurora 날씨 앱", { exact: true }).first()).toBeVisible();
  await expectSettled(page);
  await mkdir(screenshots, { recursive: true });
  await settleAndCapture(page, resolve(screenshots, "dashboard.png"));
  expect(pageErrors).toEqual([]);
});

test("검수 카드 상세의 확인 항목과 결과를 캡처한다", async ({ page }) => {
  const { pageErrors } = await prepare(page, "card-detail", `/?folder=${readmeDemoIds.folderId}`);
  const reviewCard = page.locator(`[data-card-id="${readmeDemoIds.cardIds.review}"]`);
  await expect(reviewCard).toBeVisible();
  await reviewCard.locator(".v3-postit-open").click();
  await expect(page.getByTestId("card-detail")).toBeVisible();
  await expect(page.getByText("비행기 모드에서 앱을 열어 마지막 예보가 보이는지 봐 주세요", { exact: true })).toBeVisible();
  await expect(page.getByText("오프라인에서도 마지막 예보가 나타납니다.", { exact: true })).toBeVisible();
  await expect(page.getByText("변경 내용을 검수해 주세요", { exact: true })).toBeVisible();
  await expectSettled(page);
  await mkdir(screenshots, { recursive: true });
  await settleAndCapture(page, resolve(screenshots, "card-detail.png"));
  expect(pageErrors).toEqual([]);
});

test("영구 세션의 보고 판과 대화, 모바일 배치를 캡처한다", async ({ page, browser }) => {
  const { pageErrors } = await prepare(page, "persistent-session", `/persistent/${readmeDemoIds.sessionIds.persistent}`);
  await expect(page.getByTestId("persistent-session-screen")).toBeVisible();
  await expect(page.getByText("오늘 끝난 것 정리해 줘", { exact: true })).toBeVisible();
  await expect(page.locator(".pas-report")).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: "주간 사용량" }).click();
  await expect(page.getByTestId("persistent-session-weekly-usage")).toBeVisible();
  await expectSettled(page);
  await mkdir(screenshots, { recursive: true });
  await settleAndCapture(page, resolve(screenshots, "persistent-session.png"));
  expect(pageErrors).toEqual([]);
});

test("모바일 PAS 배치가 지원되면 캡처한다", async ({ browser }) => {
  await capturePersistentSession(browser);
});
