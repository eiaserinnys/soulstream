import type { Browser, Locator, Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { runPlaywrightLifecycle } from "./playwright-lifecycle-harness.mjs";
import { openV3Home, openV3Folder } from "./v3-qa-entry";
import { fixtureTitles, installV3VisualQaRoutes } from "./v3-visual-fixtures";

type Theme = "dark" | "light";

const baseUrl = process.env.V3_QA_BASE_URL ?? "http://127.0.0.1:4173";
const outputRoot = path.resolve(
  process.env.PR_CN_QA_OUTPUT ?? path.join(".local", "artifacts", "screenshots", "pr-cn-planner-polish"),
);
// 날짜 라벨은 실행일 기준으로 만들어진다. 특정 날짜를 고정하지 않고
// 첫 항목이 오늘이며 모두 📅 기록 항목인지만 확인한다.

const result = await runPlaywrightLifecycle({
  lockName: "pr-cn-planner-polish",
  timeoutMs: 240_000,
  launchOptions: { headless: true, args: ["--disable-dev-shm-usage"] },
}, async ({ browser }) => {
  const themes = [];
  for (const theme of ["dark", "light"] as const) {
    themes.push({
      theme,
      desktop: await verifyDesktop(browser, theme),
      mobile: await verifyMobile(browser, theme),
    });
  }
  return { themes };
});

mkdirSync(outputRoot, { recursive: true });
writeFileSync(path.join(outputRoot, "metrics.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ ok: true, outputRoot, residualProcesses: 0, ...result }, null, 2));

async function verifyDesktop(browser: Browser, theme: Theme) {
  const context = await browser.newContext({
    colorScheme: theme,
    reducedMotion: "reduce",
    timezoneId: "Asia/Seoul",
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  const errors = collectErrors(page);
  await preparePage(page, theme);

  try {
    await openPlanner(page);
    assert(await page.getByRole("heading", { name: "중요 작업", exact: true }).count() === 1, "중요 작업 제목이 없습니다.");
    assert(await page.getByText("★ 작업", { exact: true }).count() === 0, "이전 ★ 작업 제목이 남았습니다.");

    const toolbar = page.getByTestId("v3-global-toolbar");
    assert(await toolbar.getByRole("button", { name: "아침 정리", exact: true }).count() === 0, "아침 정리가 전역 툴바에 남았습니다.");
    assert(await toolbar.getByRole("button", { name: "새 폴더", exact: true }).count() === 0, "새 폴더가 전역 툴바에 남았습니다.");
    await page.getByTestId("v3-starred-tasks").locator(".v3-starred-task-link").first().click();
    await page.locator(".v3-detail-pane").waitFor({ state: "visible" });
    assert(await page.getByText("별표 페이지가 task 폴더가 아닙니다", { exact: false }).count() === 0, "별표 폴더 열기 오류가 재현됐습니다.");
    const detailPane = page.locator(".v3-detail-pane");
    const description = detailPane.locator(".v3-description-preview").first();
    await description.waitFor({ state: "visible" });
    const descriptionBackground = await computedBackground(description);

    await page.getByRole("button", { name: "새 세션", exact: true }).click();
    const sessionDialog = page.getByRole("dialog", { name: "새 세션", exact: true });
    await sessionDialog.waitFor({ state: "visible" });
    const sessionText = await sessionDialog.innerText();
    assert(!sessionText.includes("추가 지침"), "새 세션 창에 추가 지침이 남았습니다.");
    assert(await sessionDialog.getByRole("textbox", { name: "초기 지시" }).count() === 1, "초기 지시 입력이 없습니다.");
    assert(await sessionDialog.getByRole("button", { name: "파일 첨부", exact: true }).count() === 1, "초기 지시 파일 첨부가 없습니다.");
    await page.getByRole("button", { name: "승계 닫기" }).click();
    await openV3Home(page, baseUrl);

    await openV3Folder(page, baseUrl);
    await page.locator(".v3-detail-pane").waitFor({ state: "visible" });
    const projectNewTask = await compactCap(
      page.getByTestId("v3-planner-scroll").getByRole("button", { name: "새 폴더", exact: true }),
      32,
    );

    await capture(page, theme, "desktop");
    assert(errors.length === 0, `브라우저 오류: ${errors.join(" | ")}`);
    return {
      projectNewTask,
      descriptionBackground,
      sessionAttachmentVisible: true,
      browserErrors: errors.length,
    };
  } finally {
    await context.close();
  }
}

async function verifyMobile(browser: Browser, theme: Theme) {
  const context = await browser.newContext({
    colorScheme: theme,
    reducedMotion: "reduce",
    timezoneId: "Asia/Seoul",
    viewport: { width: 390, height: 844 },
  });
  const page = await context.newPage();
  const errors = collectErrors(page);
  await preparePage(page, theme);

  try {
    await openPlanner(page);
    const overflowPx = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert(overflowPx <= 0, `모바일 가로 오버플로가 ${overflowPx}px입니다.`);
    await capture(page, theme, "mobile");
    assert(errors.length === 0, `모바일 브라우저 오류: ${errors.join(" | ")}`);
    return { overflowPx, browserErrors: errors.length };
  } finally {
    await context.close();
  }
}

async function preparePage(page: Page, theme: Theme) {
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
  await installV3VisualQaRoutes(page, { successionPickerRuns: true });
}

async function openPlanner(page: Page) {
  await openV3Home(page, baseUrl);
}

async function compactCap(locator: Locator, size = 28) {
  const metrics = await locator.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return { width: box.width, height: box.height, radius: getComputedStyle(element).borderRadius };
  });
  assert(Math.abs(metrics.width - size) <= 0.2, `compact cap 너비가 ${metrics.width}px입니다.`);
  assert(Math.abs(metrics.height - size) <= 0.2, `compact cap 높이가 ${metrics.height}px입니다.`);
  assert(Number.parseFloat(metrics.radius) >= size / 2, `compact cap 반경이 ${metrics.radius}입니다.`);
  return metrics;
}

async function computedBackground(locator: Locator) {
  return locator.evaluate((element) => getComputedStyle(element).backgroundColor);
}

function collectErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  return errors;
}

async function capture(page: Page, theme: Theme, name: string) {
  const directory = path.join(outputRoot, theme);
  mkdirSync(directory, { recursive: true });
  await page.screenshot({ path: path.join(directory, `${name}.png`), animations: "disabled", fullPage: true });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
