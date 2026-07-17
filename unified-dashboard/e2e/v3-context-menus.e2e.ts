import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

import { fixtureTitles, installV3VisualQaRoutes } from "./v3-visual-fixtures";

const BASE_URL = process.env.V3_QA_BASE_URL ?? "http://127.0.0.1:4173";
const OUTPUT_ROOT = path.resolve(
  process.env.PR_O_QA_OUTPUT ?? path.join("e2e", "screenshots", "v3-context-menus"),
);

type Theme = "dark" | "light";

test.use({ serviceWorkers: "allow", timezoneId: "Asia/Seoul" });
test.describe.configure({ mode: "serial" });

for (const theme of ["dark", "light"] as const) {
  test(`PR-O · ${theme} · four context menus, succession, move round-trip, and inline board`, async ({ context, page }) => {
    test.setTimeout(180_000);
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE_URL });
    await preparePage(page, theme, { width: 1440, height: 1000 });

    await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("dashboard-layout")).toBeVisible();
    await capture(page, theme, "00-v1-smoke");

    const requests: string[] = [];
    page.on("request", (request) => requests.push(new URL(request.url()).pathname));
    await page.goto(`${BASE_URL}/v3`, { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("v3-task-task-alpha")).toBeVisible();
    await expectNoHorizontalOverflow(page);

    const projectRow = page.getByTestId("v3-all-projects")
      .locator(".v3-project-nav-row")
      .filter({ hasText: fixtureTitles.project });
    await projectRow.click({ button: "right" });
    await expect(page.getByRole("menuitem", { name: "프로젝트 열기" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "폴더 ID 복사" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "새 업무" })).toBeVisible();
    await capture(page, theme, "01-project-context-menu");
    await page.keyboard.press("Escape");

    await page.getByTestId("v3-task-task-alpha").click({ button: "right" });
    await expect(page.getByRole("menuitem", { name: "업무 열기" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "업무 페이지 ID 복사" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "별표 해제" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "완료 처리" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "오늘 플래너에 추가·제거" })).toBeVisible();
    await capture(page, theme, "02-task-context-menu");
    await page.keyboard.press("Escape");

    await page.getByTestId("v3-task-task-alpha").click();
    await expect(page.getByRole("heading", { name: fixtureTitles.primaryTask, level: 2 })).toBeVisible();
    await expect(page.getByRole("button", { name: "▦ 보드로 보기" })).toHaveCount(0);
    await expect(page.getByTestId("v3-inline-board")).toBeVisible();
    await expect.poll(() => requests.filter((pathName) => pathName === "/api/board-items").length).toBe(1);
    expect(requests.filter((pathName) => pathName === "/api/markdown-documents/doc-inline")).toHaveLength(0);

    await page.getByTestId("v3-mounted-document-doc-release").click({ button: "right" });
    await expect(page.getByRole("menuitem", { name: "문서 열기" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "페이지 ID 복사" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "업무에서 마운트 해제" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "프로젝트로 승격" })).toBeVisible();
    await capture(page, theme, "03-mounted-document-context-menu");
    await page.keyboard.press("Escape");

    const alphaRun = page.locator('.v3-run-row[data-session-id="run-alpha-2"]');
    await alphaRun.click({ button: "right" });
    await expect(page.getByRole("menuitem", { name: "세션 ID 복사" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "이름 변경" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "삭제" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "＋ 이어서 새 세션 (승계)" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "다른 업무로 이동" })).toBeVisible();
    await capture(page, theme, "04-run-context-menu");
    await page.getByRole("menuitem", { name: "세션 ID 복사" }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("run-alpha-2");

    await alphaRun.click({ button: "right" });
    await page.getByRole("menuitem", { name: "＋ 이어서 새 세션 (승계)" }).click();
    await expect(page.getByRole("heading", { name: "새 세션", exact: true })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "이어받을 이전 세션" })).toHaveValue("0");
    await expect(page.locator(".v3-succession-modal")).toContainText("시각 QA 순회 · run #2");
    await expect(page.locator(".v3-succession-modal")).not.toContainText("run-alpha-2");
    await capture(page, theme, "05-targeted-succession");
    await page.getByRole("button", { name: "승계 닫기" }).click();

    await alphaRun.click({ button: "right" });
    await page.getByRole("menuitem", { name: "다른 업무로 이동" }).click();
    await expect(page.getByRole("heading", { name: "다른 업무로 이동" })).toBeVisible();
    await page.getByRole("button", { name: new RegExp(fixtureTitles.secondaryTask) }).click();
    await expect(alphaRun).toHaveCount(0);

    await page.getByRole("button", { name: "오늘 플래너로 돌아가기" }).click();
    await page.getByTestId("v3-task-task-beta").click();
    const movedRun = page.locator('.v3-run-row[data-session-id="run-alpha-2"]');
    await expect(movedRun).toBeVisible();
    await movedRun.click({ button: "right" });
    await page.getByRole("menuitem", { name: "다른 업무로 이동" }).click();
    await page.getByRole("button", { name: new RegExp(fixtureTitles.primaryTask) }).click();
    await expect(movedRun).toHaveCount(0);

    await page.getByRole("button", { name: "오늘 플래너로 돌아가기" }).click();
    await page.getByTestId("v3-task-task-alpha").click();
    await expect(page.locator('.v3-run-row[data-session-id="run-alpha-2"]')).toBeVisible();

    await page.getByRole("button", { name: /PR-O 결정 로그/ }).click();
    await expect(page.getByTestId("v3-inline-markdown")).toContainText("마크다운 본문은 행을 연 뒤에만 불러옵니다.");
    await expect.poll(() => requests.filter((pathName) => pathName === "/api/markdown-documents/doc-inline").length).toBe(1);
    await capture(page, theme, "06-inline-markdown");

    await page.getByRole("button", { name: /검증 현황/ }).click();
    const customView = page.getByTitle("검증 현황");
    await expect(customView).toBeVisible();
    await expect(customView).toHaveAttribute("sandbox", "allow-scripts");
    await expect(page.getByTestId("v3-inline-markdown")).toHaveCount(0);
    await capture(page, theme, "07-inline-custom-view");
    await expectNoHorizontalOverflow(page);
  });
}

test("PR-O · 390px · context menu uses mobile dialog without overflow", async ({ page }) => {
  test.setTimeout(90_000);
  await preparePage(page, "dark", { width: 390, height: 844 });
  await page.goto(`${BASE_URL}/v3`, { waitUntil: "domcontentloaded" });
  const task = page.getByTestId("v3-task-task-alpha");
  await expect(task).toBeVisible();
  await task.click({ button: "right" });
  await expect(page.getByTestId("v3-context-menu-mobile")).toBeVisible();
  await expect(page.getByRole("button", { name: "업무 열기" })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await capture(page, "dark", "08-mobile-390-context-menu");
});

async function preparePage(page: Page, theme: Theme, viewport: { width: number; height: number }) {
  await page.setViewportSize(viewport);
  await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
  await page.addInitScript((appearance: Theme) => {
    localStorage.setItem("soul-dashboard-theme", appearance);
    localStorage.setItem("ls.webglGlass", "0");
    const serviceWorker = navigator.serviceWorker;
    if (!serviceWorker) return;
    Object.defineProperty(serviceWorker, "register", {
      configurable: true,
      value: async () => ({
        update: async () => undefined,
        active: null,
        installing: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }),
    });
    Object.defineProperty(serviceWorker, "controller", { configurable: true, get: () => null });
  }, theme);
  await installV3VisualQaRoutes(page);
}

async function expectNoHorizontalOverflow(page: Page) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
}

async function capture(page: Page, theme: Theme, state: string) {
  const output = path.join(OUTPUT_ROOT, theme);
  mkdirSync(output, { recursive: true });
  await page.screenshot({ path: path.join(output, `${state}.png`), animations: "disabled" });
}
