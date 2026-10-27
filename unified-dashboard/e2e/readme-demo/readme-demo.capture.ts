import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { installReadmeDemoRoutes, readmeDemoIds, type DemoFixtureDiagnostics } from "./demo-fixtures";

const screenshots = resolve(dirname(fileURLToPath(import.meta.url)), "../../../docs/screenshots");

async function prepare(page: Page, diagnostics: DemoFixtureDiagnostics, path: string) {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
    console.error(`[readme-demo:page-error] ${error.message}`);
  });
  await installReadmeDemoRoutes(page, diagnostics);
  await page.goto(path, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => Boolean(document.querySelector(".v3-shell, .persistent-session-screen")), null, { timeout: 90_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(700);
  return pageErrors;
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

test("대시보드에 폴더, 카드와 실행 중 채팅을 함께 캡처한다", async ({ page }) => {
  const diagnostics: DemoFixtureDiagnostics = { registeredApi: [], unregisteredApi: [] };
  const pageErrors = await prepare(page, diagnostics, `/?folder=${readmeDemoIds.folderId}`);
  await expect(page.getByTestId(`v3-session-row-${readmeDemoIds.sessionIds.running}`)).toBeVisible();
  await page.getByTestId(`v3-session-row-${readmeDemoIds.sessionIds.running}`).click();
  await expect(page.getByTestId("v3-standalone-session-chat")).toBeVisible();
  const cards = page.getByTestId("v3-folder-cards-section");
  await expect(cards).toContainText("위젯에 시간대별 강수 확률 넣기");
  await expect(cards).toContainText("오프라인에서 마지막 예보 보여 주기");
  await expect(page.locator(".v3-chat-pane")).toContainText("위젯 폭에 맞춰 두 시간대씩 묶어 표시했습니다.");
  await cards.scrollIntoViewIfNeeded();
  await expect(page.getByText("📱 Aurora 날씨 앱", { exact: true }).first()).toBeVisible();
  await expect(page.locator("[role=alert]:visible")).toHaveCount(0);
  await mkdir(screenshots, { recursive: true });
  await settleAndCapture(page, resolve(screenshots, "dashboard.png"));
  report("dashboard", diagnostics, pageErrors);
  expect(pageErrors).toEqual([]);
});

test("검수 카드 상세의 확인 항목과 결과를 캡처한다", async ({ page }) => {
  const diagnostics: DemoFixtureDiagnostics = { registeredApi: [], unregisteredApi: [] };
  const pageErrors = await prepare(page, diagnostics, `/?folder=${readmeDemoIds.folderId}`);
  const reviewTitle = page.getByText("오프라인에서 마지막 예보 보여 주기", { exact: true }).last();
  await expect(reviewTitle).toBeVisible();
  await reviewTitle.click();
  await expect(page.getByText("비행기 모드에서 앱을 열어 마지막 예보가 보이는지 봐 주세요", { exact: true })).toBeVisible();
  await expect(page.getByText("오프라인에서도 마지막 예보가 나타납니다.", { exact: true })).toBeVisible();
  await expect(page.locator("[role=alert]:visible")).toHaveCount(0);
  await mkdir(screenshots, { recursive: true });
  await settleAndCapture(page, resolve(screenshots, "card-detail.png"));
  report("card-detail", diagnostics, pageErrors);
  expect(pageErrors).toEqual([]);
});

test("영구 세션의 보고 판과 대화를 캡처한다", async ({ page }) => {
  const diagnostics: DemoFixtureDiagnostics = { registeredApi: [], unregisteredApi: [] };
  const pageErrors = await prepare(page, diagnostics, `/persistent/${readmeDemoIds.sessionIds.persistent}`);
  await expect(page.getByTestId("persistent-session-screen")).toBeVisible();
  await expect(page.getByText("오늘 끝난 것 정리해 줘", { exact: true })).toBeVisible();
  await expect(page.locator(".pas-report")).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: "주간 사용량" }).click();
  await expect(page.getByTestId("persistent-session-weekly-usage")).toBeVisible();
  await expect(page.locator("[role=alert]:visible")).toHaveCount(0);
  await mkdir(screenshots, { recursive: true });
  await settleAndCapture(page, resolve(screenshots, "persistent-session.png"));
  report("persistent-session", diagnostics, pageErrors);
  expect(pageErrors).toEqual([]);
});

test.describe("모바일 영구 세션", () => {
  test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3 });

  test("모바일 배치가 지원되면 캡처한다", async ({ page }) => {
    const diagnostics: DemoFixtureDiagnostics = { registeredApi: [], unregisteredApi: [] };
    const pageErrors = await prepare(page, diagnostics, `/persistent/${readmeDemoIds.sessionIds.persistent}`);
    await expect(page.getByTestId("persistent-session-screen")).toBeVisible();
    const layout = await page.evaluate(() => ({
      width: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      mobile: window.matchMedia("(max-width: 760px)").matches,
      hasChat: Boolean(document.querySelector(".persistent-session-main")),
    }));
    if (!layout.mobile || layout.scrollWidth > layout.width || !layout.hasChat) {
      console.log(`[readme-demo:mobile] 캡처 생략: ${JSON.stringify(layout)}`);
      report("mobile", diagnostics, pageErrors);
      test.skip(true, "모바일 전용 배치 또는 가로 넘침 없는 화면을 확인하지 못했습니다.");
    }
    await expect(page.getByText("오늘 끝난 것 정리해 줘", { exact: true })).toBeVisible();
    await expect(page.locator("[role=alert]:visible")).toHaveCount(0);
    await mkdir(screenshots, { recursive: true });
    await settleAndCapture(page, resolve(screenshots, "mobile.png"));
    report("mobile", diagnostics, pageErrors);
    expect(pageErrors).toEqual([]);
  });
});
