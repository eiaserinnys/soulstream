import type { Browser, Locator, Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

import { runPlaywrightLifecycle } from "./playwright-lifecycle-harness.mjs";
import { fixtureTitles, installV3VisualQaRoutes } from "./v3-visual-fixtures";

const baseUrl = process.env.V3_QA_BASE_URL ?? "http://127.0.0.1:4173";
const outputRoot = path.resolve(
  process.env.PR_AK_QA_OUTPUT ?? path.join("e2e", "screenshots", "v3-context-menu-parity"),
);

const result = await runPlaywrightLifecycle({
  lockName: "pr-ak-v3-context-menu-parity",
  timeoutMs: 180_000,
}, async ({ browser }) => ({
  dark: await verifyTheme(browser, "dark"),
  light: await verifyTheme(browser, "light"),
}));

console.log(JSON.stringify({ ok: true, residualProcesses: 0, ...result }, null, 2));

async function verifyTheme(browser: Browser, theme: "dark" | "light") {
  const context = await browser.newContext({
    colorScheme: theme,
    reducedMotion: "reduce",
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  await preparePage(page, theme);

  try {
    await page.goto(`${baseUrl}/v3`, { waitUntil: "domcontentloaded" });
    const dailyTask = page.getByTestId("v3-task-task-alpha");
    const starredTask = page.getByTestId("v3-starred-tasks").locator(".v3-starred-task-link").filter({ hasText: fixtureTitles.primaryTask });
    await dailyTask.waitFor({ state: "visible" });
    await starredTask.waitFor({ state: "visible" });

    await openContextMenu(starredTask);
    await assertMenuItems(page, [
      "업무 열기",
      "업무 페이지 ID 복사",
      "별표 해제",
      "완료 처리",
      "오늘 플래너에서 제거",
    ]);
    await page.getByRole("menuitem", { name: "오늘 플래너에서 제거" }).click();
    await dailyTask.waitFor({ state: "detached" });

    await openContextMenu(starredTask);
    await page.getByRole("menuitem", { name: "오늘 플래너에 추가" }).click();
    await dailyTask.waitFor({ state: "visible" });

    const reviewNavigation = page.getByTestId("v3-review-navigation").locator(".v3-review-nav-link").first();
    await openContextMenu(reviewNavigation);
    await assertSessionCommonMenu(page);
    await assertMissingMenuItems(page, ["＋ 이어서 새 세션 (승계)", "다른 업무로 이동"]);
    await page.keyboard.press("Escape");

    await page.getByTestId("v3-review-navigation").getByRole("button", { name: /전체 \d+건 보기|검수 패널 열기/ }).click();
    const reviewRow = page.getByTestId("v3-review-queue-list").locator(".v3-run-row").first();
    await reviewRow.waitFor({ state: "visible" });
    await openContextMenu(reviewRow);
    await assertSessionCommonMenu(page);
    await assertMissingMenuItems(page, ["＋ 이어서 새 세션 (승계)", "다른 업무로 이동"]);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");

    const projectRow = page.getByTestId("v3-all-projects").locator(".v3-project-nav-row").filter({ hasText: fixtureTitles.project });
    await projectRow.getByRole("button").click();
    const projectDocument = page.locator(".v3-document-list button").filter({ hasText: fixtureTitles.document });
    await projectDocument.waitFor({ state: "visible" });
    await openContextMenu(projectDocument);
    await assertMenuItems(page, ["문서 열기", "페이지 ID 복사"]);
    await assertMissingMenuItems(page, ["업무에서 마운트 해제", "프로젝트로 승격"]);
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "← 오늘" }).click();
    await dailyTask.waitFor({ state: "visible" });

    await openContextMenu(starredTask);
    await page.getByRole("menuitem", { name: "완료 처리" }).click();
    await dailyTask.waitFor({ state: "detached" });
    await openContextMenu(starredTask);
    const complete = page.getByRole("menuitem", { name: "완료 처리" });
    assert(await complete.isDisabled(), "완료된 업무의 완료 처리가 비활성화되지 않았습니다.");
    await capture(page, theme, "01-context-menu-parity");

    return {
      todayRoundtrip: true,
      completionImmediate: true,
      reviewNavigationMenu: true,
      reviewPanelMenu: true,
      projectDocumentMenu: true,
    };
  } finally {
    await context.close();
  }
}

async function preparePage(page: Page, theme: "dark" | "light") {
  await page.addInitScript({ content: `
    localStorage.setItem("soul-dashboard-theme", ${JSON.stringify(theme)});
    localStorage.setItem("ls.webglGlass", "0");
    const serviceWorker = navigator.serviceWorker;
    if (serviceWorker) {
      Object.defineProperty(serviceWorker, "register", {
        configurable: true,
        value: async () => ({ update: async () => undefined, active: null, installing: null, addEventListener: () => undefined, removeEventListener: () => undefined }),
      });
      Object.defineProperty(serviceWorker, "controller", { configurable: true, get: () => null });
    }
  ` });
  await installV3VisualQaRoutes(page, { contextMenuParity: true });
}

async function openContextMenu(target: Locator) {
  await target.click({ button: "right" });
}

async function assertSessionCommonMenu(page: Page) {
  await assertMenuItems(page, ["세션 ID 복사", "이름 변경", "삭제"]);
}

async function assertMenuItems(page: Page, labels: readonly string[]) {
  for (const label of labels) await page.getByRole("menuitem", { name: label }).waitFor({ state: "visible" });
}

async function assertMissingMenuItems(page: Page, labels: readonly string[]) {
  for (const label of labels) assert(await page.getByRole("menuitem", { name: label }).count() === 0, `예외 액션이 노출됐습니다: ${label}`);
}

async function capture(page: Page, theme: string, name: string) {
  const directory = path.join(outputRoot, theme);
  mkdirSync(directory, { recursive: true });
  await page.screenshot({ path: path.join(directory, `${name}.png`), animations: "disabled", fullPage: true });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
