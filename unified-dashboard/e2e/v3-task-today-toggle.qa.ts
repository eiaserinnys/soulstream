import type { Browser, Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

import { runPlaywrightLifecycle } from "./playwright-lifecycle-harness.mjs";
import { fixtureTitles, installV3VisualQaRoutes } from "./v3-visual-fixtures";

const baseUrl = process.env.V3_QA_BASE_URL ?? "http://127.0.0.1:4173";
const outputRoot = path.resolve(
  process.env.PR_AW_QA_OUTPUT ?? path.join("e2e", "screenshots", "v3-task-today-toggle"),
);

const result = await runPlaywrightLifecycle({
  lockName: "pr-aw-v3-task-today-toggle",
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
  let plannerTodayRequests = 0;
  page.on("pageerror", (error) => console.error(`[pr-aw/${theme}] pageerror`, error));
  await preparePage(page, theme, (count) => { plannerTodayRequests = count; });

  try {
    await page.goto(`${baseUrl}/v3`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("v3-task-task-alpha").waitFor({ state: "visible", timeout: 20_000 });
    const untouchedTask = page.getByTestId("v3-task-task-beta");
    await untouchedTask.waitFor({ state: "visible" });
    await page.getByTestId("v3-all-projects")
      .getByRole("button", { name: fixtureTitles.project, exact: true })
      .click();
    const toggledTask = page.getByTestId("v3-task-task-carryover");
    await toggledTask.waitFor({ state: "visible" });
    await toggledTask.click();
    await page.locator(".v3-task-title-button").filter({ hasText: fixtureTitles.carryoverTask })
      .waitFor({ state: "visible" });

    const addToggle = page.getByRole("button", { name: "오늘 플래너에 추가", exact: true });
    await addToggle.waitFor({ state: "visible" });
    assert(await addToggle.getAttribute("aria-pressed") === "false", "오늘 미포함 상태가 눌림 해제로 표시되지 않았습니다.");
    await addToggle.click();
    const removeToggle = page.getByRole("button", { name: "오늘 플래너에서 제거", exact: true });
    await removeToggle.waitFor({ state: "visible" });
    assert(await removeToggle.getAttribute("aria-pressed") === "true", "오늘 포함 상태가 눌림으로 표시되지 않았습니다.");
    await capture(page, theme, "01-added-toggle-state");

    await page.getByRole("button", { name: "← 오늘로" }).click();
    await toggledTask.waitFor({ state: "visible" });
    await capture(page, theme, "02-added-daily-row");

    await startDailyMutationObserver(page, "task-beta");
    await toggledTask.click();
    await removeToggle.waitFor({ state: "visible" });
    await removeToggle.click();
    await toggledTask.waitFor({ state: "detached" });
    await addToggle.waitFor({ state: "visible" });
    await capture(page, theme, "03-removed-toggle-state");

    await addToggle.click();
    await toggledTask.waitFor({ state: "visible" });
    await removeToggle.waitFor({ state: "visible" });
    const mutations = await stopDailyMutationObserver(page);
    assert(mutations.listChild === 2, `오늘 목록 구조가 ${mutations.listChild}회 변경되었습니다.`);
    assert(mutations.untouched === 0, `무관한 업무 행이 ${mutations.untouched}회 변경되었습니다.`);
    assert(plannerTodayRequests === 1, `토글이 오늘 플래너를 ${plannerTodayRequests}회 광역 재조회했습니다.`);
    await capture(page, theme, "04-restored-toggle-and-row");

    await removeToggle.click();
    await toggledTask.waitFor({ state: "detached" });
    await page.getByRole("button", { name: "업무 상세 닫기" }).click();

    await page.locator('[data-session-id="review-session"]').click();
    const standalone = page.getByTestId("v3-standalone-task-empty");
    await standalone.waitFor({ state: "visible" });
    assert(await standalone.getByRole("button", { name: /오늘 플래너/ }).count() === 0, "빈 업무창에 오늘 토글이 노출되었습니다.");

    return {
      stateTransition: true,
      dailyRowOnly: mutations,
      standaloneHidden: true,
      plannerTodayRequests,
    };
  } finally {
    await context.close();
  }
}

async function preparePage(page: Page, theme: "dark" | "light", onPlannerTodayRequest: (count: number) => void) {
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
  await installV3VisualQaRoutes(page, { contextMenuParity: true, onPlannerTodayRequest });
}

async function startDailyMutationObserver(page: Page, untouchedTaskId: string) {
  await page.evaluate((taskId) => {
    const list = document.querySelector(".v3-planner .v3-task-list");
    const untouched = document.querySelector(`[data-testid="v3-task-${taskId}"]`);
    if (!list || !untouched) throw new Error("오늘 목록 MutationObserver 대상을 찾지 못했습니다.");
    const state = { listChild: 0, untouched: 0, observers: [] as MutationObserver[] };
    const listObserver = new MutationObserver((records) => { state.listChild += records.length; });
    listObserver.observe(list, { childList: true });
    const untouchedObserver = new MutationObserver((records) => { state.untouched += records.length; });
    untouchedObserver.observe(untouched, { attributes: true, characterData: true, childList: true, subtree: true });
    state.observers.push(listObserver, untouchedObserver);
    (window as Window & { __prAwDailyObserver?: typeof state }).__prAwDailyObserver = state;
  }, untouchedTaskId);
}

async function stopDailyMutationObserver(page: Page): Promise<{ listChild: number; untouched: number }> {
  return await page.evaluate(() => {
    const state = (window as Window & {
      __prAwDailyObserver?: { listChild: number; untouched: number; observers: MutationObserver[] };
    }).__prAwDailyObserver;
    if (!state) throw new Error("오늘 목록 MutationObserver 상태가 없습니다.");
    for (const observer of state.observers) observer.disconnect();
    return { listChild: state.listChild, untouched: state.untouched };
  });
}

async function capture(page: Page, theme: string, name: string) {
  const directory = path.join(outputRoot, theme);
  mkdirSync(directory, { recursive: true });
  await page.screenshot({ path: path.join(directory, `${name}.png`), animations: "disabled", fullPage: true });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
