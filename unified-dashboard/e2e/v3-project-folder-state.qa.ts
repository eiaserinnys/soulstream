import type { Browser, Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

import { runPlaywrightLifecycle } from "./playwright-lifecycle-harness.mjs";
import { installV3VisualQaRoutes, type V3VisualQaRouteOptions } from "./v3-visual-fixtures";

const baseUrl = process.env.V3_QA_BASE_URL ?? "http://127.0.0.1:4173";
const outputRoot = path.resolve(
  process.env.PR_AL_QA_OUTPUT ?? path.join("e2e", "screenshots", "v3-project-folder-state"),
);

const result = await runPlaywrightLifecycle({
  lockName: "pr-al-v3-project-folder-state",
  timeoutMs: 180_000,
}, async ({ browser }) => ({
  dark: await verifyTheme(browser, "dark"),
  light: await verifyTheme(browser, "light"),
}));

console.log(JSON.stringify({ ok: true, residualProcesses: 0, ...result }, null, 2));

async function verifyTheme(browser: Browser, theme: "dark" | "light") {
  await verifyDelayed(browser, theme);
  await verifyFailure(browser, theme);
  await verifyUnlinked(browser, theme);
  return { delayed: true, failureRetry: true, unlinked: true };
}

async function verifyDelayed(browser: Browser, theme: "dark" | "light") {
  await withPage(browser, theme, {
    projectResolutionMode: "delayed",
    projectResolutionDelayMs: 900,
  }, async (page) => {
    await openProject(page);
    await page.getByTestId("v3-project-loading").waitFor({ state: "visible" });
    await capture(page, theme, "01-loading");
    await page.locator(".v3-project-title h1").filter({ hasText: "소울스트림" }).waitFor({ state: "visible" });
  });
}

async function verifyFailure(browser: Browser, theme: "dark" | "light") {
  await withPage(browser, theme, { projectResolutionMode: "fail-once" }, async (page) => {
    await openProject(page);
    const error = page.getByTestId("v3-project-error");
    await error.waitFor({ state: "visible" });
    await capture(page, theme, "02-error");
    await error.getByRole("button", { name: "다시 시도" }).click();
    await page.locator(".v3-project-title h1").filter({ hasText: "소울스트림" }).waitFor({ state: "visible" });
  });
}

async function verifyUnlinked(browser: Browser, theme: "dark" | "light") {
  await withPage(browser, theme, { projectResolutionMode: "unlinked" }, async (page) => {
    await openProject(page);
    const empty = page.getByTestId("v3-empty-project-view");
    await empty.waitFor({ state: "visible" });
    assert((await empty.textContent())?.includes("내용이 없습니다."), "미연결 빈 상태 문구가 다릅니다.");
    assert(!(await empty.textContent())?.includes("연결"), "미연결 상태에 내부 연결 설명이 노출됐습니다.");
    await capture(page, theme, "03-unlinked");
  });
}

async function withPage(
  browser: Browser,
  theme: "dark" | "light",
  options: V3VisualQaRouteOptions,
  verify: (page: Page) => Promise<void>,
) {
  const context = await browser.newContext({
    colorScheme: theme,
    reducedMotion: "reduce",
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
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
  await installV3VisualQaRoutes(page, options);
  try {
    await page.goto(`${baseUrl}/v3`, { waitUntil: "domcontentloaded" });
    await verify(page);
  } finally {
    await context.close();
  }
}

async function openProject(page: Page) {
  const navigation = page.getByTestId("v3-all-projects");
  await navigation.waitFor({ state: "visible" });
  const row = navigation.locator(".v3-project-nav-row").filter({ hasText: "소울스트림" });
  await row.getByRole("button").click();
}

async function capture(page: Page, theme: string, name: string) {
  const directory = path.join(outputRoot, theme);
  mkdirSync(directory, { recursive: true });
  await page.screenshot({ path: path.join(directory, `${name}.png`), animations: "disabled", fullPage: true });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
