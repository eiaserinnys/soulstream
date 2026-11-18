import type { Browser, Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

import { runPlaywrightLifecycle } from "./playwright-lifecycle-harness.mjs";
import { openV3Folder } from "./v3-qa-entry";
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

console.log(JSON.stringify({ ok: true, outputRoot, residualProcesses: 0, ...result }, null, 2));

async function verifyTheme(browser: Browser, theme: "dark" | "light") {
  const context = await browser.newContext({
    colorScheme: theme,
    reducedMotion: "reduce",
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  const requests = { dailyOperations: 0, plannerReads: 0 };
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (request.method() === "POST" && url.pathname.startsWith("/api/pages/daily-") && url.pathname.endsWith("/operations")) {
      requests.dailyOperations += 1;
    }
    if (request.method() === "GET" && url.pathname.startsWith("/api/planner/")) {
      requests.plannerReads += 1;
    }
  });
  page.on("pageerror", (error) => console.error(`[pr-aw/${theme}] pageerror`, error));
  await preparePage(page, theme);

  try {
    await openV3Folder(page, baseUrl);
    await page.getByTestId("v3-task-task-alpha").waitFor({ state: "visible", timeout: 20_000 });
    await page.getByTestId("v3-task-task-beta").waitFor({ state: "visible" });
    const toggledTask = page.getByTestId("v3-task-task-carryover");
    await toggledTask.waitFor({ state: "visible" });
    await toggledTask.click();
    await page.locator(".v3-task-title-button").filter({ hasText: fixtureTitles.carryoverTask })
      .waitFor({ state: "visible" });

    const addToggle = page.getByRole("button", { name: "오늘 플래너에 추가", exact: true });
    await addToggle.waitFor({ state: "visible" });
    assert(await addToggle.getAttribute("aria-pressed") === "false", "오늘 미포함 상태가 눌림 해제로 표시되지 않았습니다.");

    const operationsBefore = requests.dailyOperations;
    const plannerReadsBefore = requests.plannerReads;
    const addResponse = page.waitForResponse((response) => (
      response.request().method() === "POST"
      && new URL(response.url()).pathname.endsWith("/operations")
    ));
    await addToggle.click();
    await addResponse;
    const removeToggle = page.getByRole("button", { name: "오늘 플래너에서 제거", exact: true });
    await removeToggle.waitFor({ state: "visible" });
    assert(await removeToggle.getAttribute("aria-pressed") === "true", "오늘 포함 상태가 눌림으로 표시되지 않았습니다.");
    assert(
      requests.dailyOperations === operationsBefore + 1,
      `오늘 추가가 데일리 operations를 ${requests.dailyOperations - operationsBefore}회 호출했습니다.`,
    );
    await capture(page, theme, "01-added-toggle-state");

    const removeResponse = page.waitForResponse((response) => (
      response.request().method() === "POST"
      && new URL(response.url()).pathname.endsWith("/operations")
    ));
    await removeToggle.click();
    await removeResponse;
    await addToggle.waitFor({ state: "visible" });
    assert(
      requests.dailyOperations === operationsBefore + 2,
      `오늘 제거가 데일리 operations를 ${requests.dailyOperations - operationsBefore}회 호출했습니다.`,
    );
    assert(
      requests.plannerReads === plannerReadsBefore,
      `토글이 오늘 플래너를 ${requests.plannerReads - plannerReadsBefore}회 광역 재조회했습니다.`,
    );
    await capture(page, theme, "03-removed-toggle-state");

    // 하위 폴더 상세에서 상위 폴더로 한 번 올라간 뒤 오늘 플래너로 돌아간다.
    await page.getByRole("button", { name: "상위 폴더로 이동" }).click();
    await page.getByRole("button", { name: "오늘 플래너로 돌아가기" }).click();
    await page.locator('[data-session-id="review-session"]').click();
    const standalone = page.getByTestId("v3-standalone-task-empty");
    await standalone.waitFor({ state: "visible" });
    assert(await standalone.getByRole("button", { name: /오늘 플래너/ }).count() === 0, "빈 폴더창에 오늘 토글이 노출되었습니다.");

    return {
      stateTransition: true,
      dailyOperationRequests: requests.dailyOperations,
      plannerWideReads: requests.plannerReads - plannerReadsBefore,
      standaloneHidden: true,
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

async function capture(page: Page, theme: string, name: string) {
  const directory = path.join(outputRoot, theme);
  mkdirSync(directory, { recursive: true });
  await page.screenshot({ path: path.join(directory, `${name}.png`), animations: "disabled", fullPage: true });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
